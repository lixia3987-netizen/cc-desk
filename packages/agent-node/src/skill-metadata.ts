import { JSON_SCHEMA, load } from 'js-yaml';
import type { SkillDiagnostic, SkillMetadataResult, SkillMetadataValue } from '@cc-desk/contracts/native-skills';

export const SKILL_METADATA_MAX_HEADER_BYTES = 8 * 1024;
export const SKILL_METADATA_MAX_FILE_BYTES = 32 * 1024;
const MAX_FIELDS = 64;
const MAX_NODES = 512;
const MAX_DEPTH = 4;
const MAX_UNKNOWN_BYTES = 4096;
const KNOWN_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor', '<<']);

class MetadataBoundaryError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
interface Frontmatter {
  header: string;
  end: number;
  headerBytes: number;
}
const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
const diagnostic = (code: string, message: string, severity: SkillDiagnostic['severity'] = 'error'): SkillDiagnostic => ({ code, message, severity });
const invalid = (name: string, issue: SkillDiagnostic, headerBytes = 0): SkillMetadataResult => ({
  format: 'invalid', name, description: '', autoMatchable: false, diagnostics: [issue], headerBytes,
});

/** Only the first line can open frontmatter. YAML interpretation belongs to js-yaml. */
function frontmatter(input: string, complete: boolean): Frontmatter | null {
  const bom = input.charCodeAt(0) === 0xfeff ? 1 : 0;
  const text = input.slice(bom);
  const newline = text.indexOf('\n');
  const firstLine = (newline < 0 ? text : text.slice(0, newline)).replace(/\r$/, '');
  if (!/^---[\t ]*$/.test(firstLine)) return null;
  const start = newline < 0 ? text.length : newline + 1;
  // A bounded prefix can end in the middle of a line (for example, ---not-a-delimiter).
  // Only a real newline proves that its closing delimiter is complete.
  const closing = complete ? /^---[\t ]*(?:\r?\n|$)/gm : /^---[\t ]*\r?\n/gm;
  closing.lastIndex = start;
  const end = closing.exec(text);
  if (!end) throw new MetadataBoundaryError(complete ? 'frontmatter_unclosed' : 'frontmatter_limit',
    complete ? 'Skill frontmatter has no closing delimiter.' : 'Skill frontmatter exceeds the bounded header read.');
  const offset = bom + end.index + end[0].length;
  const headerBytes = bytes(input.slice(0, offset));
  if (headerBytes > SKILL_METADATA_MAX_HEADER_BYTES) throw new MetadataBoundaryError('frontmatter_limit', 'Skill frontmatter exceeds the 8192 byte limit.');
  return { header: text.slice(start, end.index), end: offset, headerBytes };
}

function boundedValue(value: unknown): SkillMetadataValue {
  let fields = 0, nodes = 0;
  const visit = (current: unknown, depth: number): SkillMetadataValue => {
    if (++nodes > MAX_NODES) throw new MetadataBoundaryError('metadata_nodes', 'Skill metadata contains too many values.');
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (!current || typeof current !== 'object') throw new MetadataBoundaryError('metadata_type', 'Skill metadata must contain only finite JSON data.');
    if (depth > MAX_DEPTH) throw new MetadataBoundaryError('metadata_depth', 'Skill metadata nesting exceeds its limit.');
    if (Array.isArray(current)) return current.map(item => visit(item, depth + 1));
    if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
      throw new MetadataBoundaryError('metadata_type', 'Skill metadata must contain ordinary data mappings.');
    }
    const entries = Object.entries(current);
    fields += entries.length;
    if (fields > MAX_FIELDS) throw new MetadataBoundaryError('metadata_fields', 'Skill metadata exceeds the 64 field limit.');
    return Object.fromEntries(entries.map(([key, item]) => {
      if (FORBIDDEN_KEYS.has(key)) throw new MetadataBoundaryError('metadata_key', 'Skill metadata contains an unsupported mapping key.');
      return [key, visit(item, depth + 1)];
    }));
  };
  return visit(value, 0);
}

/** Parse bounded, inert data. No file references, scripts or metadata fields execute here. */
export function parseSkillMetadata(input: string, options: { directoryName?: string; headerComplete?: boolean } = {}): SkillMetadataResult {
  const name = typeof options.directoryName === 'string' ? options.directoryName : '';
  if (typeof input !== 'string') return invalid(name, diagnostic('input_type', 'Skill content must be text.'));
  if (bytes(input) > SKILL_METADATA_MAX_FILE_BYTES) return invalid(name, diagnostic('file_limit', 'Skill content exceeds the 32768 byte limit.'));
  if (input.includes('\0')) return invalid(name, diagnostic('input_text', 'Skill content must not contain binary NUL characters.'));
  let section: Frontmatter | null;
  try { section = frontmatter(input, options.headerComplete !== false); }
  catch (error) {
    if (error instanceof MetadataBoundaryError) return invalid(name, diagnostic(error.code, error.message), Math.min(bytes(input), SKILL_METADATA_MAX_HEADER_BYTES));
    return invalid(name, diagnostic('frontmatter_invalid', 'Skill frontmatter could not be read.'));
  }
  if (!section) return { format: 'legacy', name, description: '', autoMatchable: false,
    diagnostics: [diagnostic('legacy_format', 'This guide has no frontmatter and is available only through explicit or fixed loading.', 'warning')], headerBytes: 0 };

  let data: SkillMetadataValue;
  try {
    let nodes = 0;
    const yamlOptions = {
      schema: JSON_SCHEMA, json: false, maxDepth: 8, maxTotalMergeKeys: 0,
      onWarning: () => { throw new MetadataBoundaryError('yaml_warning', 'Skill frontmatter uses unsupported YAML syntax.'); },
      listener: (event: 'open' | 'close', state: { anchor?: string | null }) => {
        if (state.anchor != null) throw new MetadataBoundaryError('yaml_alias', 'Skill frontmatter anchors and aliases are not supported.');
        if (event === 'open' && ++nodes > MAX_NODES) throw new MetadataBoundaryError('metadata_nodes', 'Skill metadata contains too many values.');
      },
    };
    data = boundedValue(load(section.header, yamlOptions));
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new MetadataBoundaryError('metadata_mapping', 'Skill frontmatter must be a mapping.');
  } catch (error) {
    return invalid(name, diagnostic(error instanceof MetadataBoundaryError ? error.code : 'yaml_invalid',
      error instanceof MetadataBoundaryError ? error.message : 'Skill frontmatter is invalid YAML; duplicate keys and unsupported tags are refused.'), section.headerBytes);
  }

  const result: SkillMetadataResult = { format: 'standard', name, description: '', autoMatchable: true, diagnostics: [], headerBytes: section.headerBytes };
  const fieldError = (field: string, message: string) => result.diagnostics.push(diagnostic(`invalid_${field}`, message));
  const text = (key: string, limit: number, required = false): string | undefined => {
    const value = data[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string' || !value.trim() || [...value].length > limit) {
      fieldError(key.replace('-', '_'), `Skill ${key} must be nonempty text of at most ${limit} characters.`);
      return undefined;
    }
    return value;
  };
  const parsedName = text('name', 64, true);
  if (parsedName !== undefined) {
    result.name = parsedName;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsedName)) fieldError('name', 'Skill name must use lowercase ASCII letters, digits and single internal hyphens.');
    if (options.directoryName !== undefined && parsedName !== options.directoryName) fieldError('directory_name', 'Skill name must match its directory name.');
  }
  result.description = text('description', 1024, true) ?? '';
  const license = text('license', 1024);
  if (license !== undefined) result.license = license;
  const compatibility = text('compatibility', 500);
  if (compatibility !== undefined) result.compatibility = compatibility;
  const allowedTools = text('allowed-tools', 2048);
  if (allowedTools !== undefined) {
    result.allowedTools = allowedTools;
    result.diagnostics.push(diagnostic('allowed_tools_inert', 'allowed-tools is informational and does not authorize tools or bypass approval.', 'warning'));
  }
  if (data.metadata !== undefined) {
    const metadata = data.metadata;
    if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object' || Object.entries(metadata).some(([key, value]) =>
      key.length > 128 || typeof value !== 'string' || [...value].length > 1024)) {
      fieldError('metadata', 'Skill metadata must be a bounded mapping of string keys to string values.');
    } else result.metadata = Object.fromEntries(Object.entries(metadata)) as Record<string, string>;
  }
  const unknown = Object.fromEntries(Object.entries(data).filter(([key]) => !KNOWN_FIELDS.has(key)));
  if (Object.keys(unknown).length) {
    if (bytes(JSON.stringify(unknown)) > MAX_UNKNOWN_BYTES) fieldError('unknown_fields', 'Unsupported metadata exceeds its 4096 byte retention limit.');
    else result.unknownFields = unknown;
    result.diagnostics.push(diagnostic('unsupported_fields', 'Unsupported metadata is retained as inert data and does not enable execution behavior.', 'warning'));
  }
  if (result.diagnostics.some(issue => issue.severity === 'error')) { result.format = 'invalid'; result.autoMatchable = false; }
  return result;
}

/** Return the exact body for a validated complete file; legacy guides remain byte-for-byte text. */
export function extractSkillBody(input: string): string {
  const metadata = parseSkillMetadata(input);
  if (metadata.format === 'invalid') throw new Error('Skill content is invalid; a complete body cannot be extracted.');
  if (metadata.format === 'legacy') return input;
  return input.slice(frontmatter(input, true)!.end);
}
