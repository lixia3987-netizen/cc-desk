import type { JsonObject, JsonValue } from '@cc-desk/agent-core';

// Deliberately bounded subset of JSON Schema. Unknown keywords never become an
// accidental permission to send arguments the host has not validated.
type Schema = JsonObject | boolean;
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 8192;
const MAX_WORK = 32768;
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'enum', 'const', 'allOf', 'anyOf', 'oneOf', 'not',
  '$schema', 'title', 'description', 'default', 'examples', 'readOnly', 'writeOnly', 'deprecated', 'x-mcp-header',
]);
const COUNTS = ['minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties'];
const NUMBERS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'];
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: JsonObject, key: string): boolean => Object.hasOwn(value, key);
function invalidSchema(): never { throw new Error('Unsupported or invalid MCP JSON Schema.'); }

function checkJson(value: unknown, maxBytes: number): asserts value is JsonValue {
  let nodes = 0;
  const active = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) invalidSchema();
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || active.has(item)) invalidSchema();
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) invalidSchema();
    active.add(item);
    for (const child of Object.values(item)) visit(child, depth + 1);
    active.delete(item);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) invalidSchema();
}

/** Check the full schema before exposing its tool; unsupported definitions are omitted. */
export function assertMcpInputSchema(schema: JsonObject): void { assertMcpSchema(schema, true); }

/** Output schemas retain the same bounded assertions and may describe any JSON root. */
export function assertMcpOutputSchema(schema: JsonObject): void { assertMcpSchema(schema, false); }

function assertMcpSchema(schema: JsonObject, objectRoot: boolean): void {
  checkJson(schema, MAX_SCHEMA_BYTES);
  if (!object(schema) || objectRoot && schema.type !== 'object') invalidSchema();
  let schemas = 0;
  const visit = (candidate: JsonValue, depth: number): void => {
    if (++schemas > 1024 || depth > MAX_DEPTH) invalidSchema();
    if (typeof candidate === 'boolean') return;
    if (!object(candidate) || Object.keys(candidate).some(key => !KEYS.has(key))) invalidSchema();
    if (own(candidate, 'type')) {
      const types = Array.isArray(candidate.type) ? candidate.type : [candidate.type];
      if (!types.length || types.length > TYPES.size || new Set(types).size !== types.length || types.some(type => typeof type !== 'string' || !TYPES.has(type))) invalidSchema();
    }
    for (const key of ['$schema', 'title', 'description', 'x-mcp-header']) if (own(candidate, key) && typeof candidate[key] !== 'string') invalidSchema();
    if (own(candidate, '$schema') && candidate.$schema !== 'https://json-schema.org/draft/2020-12/schema' && candidate.$schema !== 'https://json-schema.org/draft/2020-12/schema#') invalidSchema();
    for (const key of ['readOnly', 'writeOnly', 'deprecated', 'uniqueItems']) if (own(candidate, key) && typeof candidate[key] !== 'boolean') invalidSchema();
    if (own(candidate, 'examples') && !Array.isArray(candidate.examples)) invalidSchema();
    for (const key of COUNTS) if (own(candidate, key) && (typeof candidate[key] !== 'number' || !Number.isSafeInteger(candidate[key]) || (candidate[key] as number) < 0)) invalidSchema();
    for (const key of NUMBERS) if (own(candidate, key) && (typeof candidate[key] !== 'number' || !Number.isFinite(candidate[key]))) invalidSchema();
    if (own(candidate, 'properties')) {
      if (!object(candidate.properties)) invalidSchema();
      for (const property of Object.values(candidate.properties)) visit(property, depth + 1);
    }
    if (own(candidate, 'required') && (!Array.isArray(candidate.required) || candidate.required.some(key => typeof key !== 'string') || new Set(candidate.required).size !== candidate.required.length)) invalidSchema();
    for (const key of ['additionalProperties', 'items', 'not']) if (own(candidate, key)) visit(candidate[key], depth + 1);
    if (own(candidate, 'enum') && (!Array.isArray(candidate.enum) || !candidate.enum.length || candidate.enum.length > 256)) invalidSchema();
    for (const key of ['allOf', 'anyOf', 'oneOf']) if (own(candidate, key)) {
      if (!Array.isArray(candidate[key]) || !candidate[key].length || candidate[key].length > 32) invalidSchema();
      for (const branch of candidate[key]) visit(branch, depth + 1);
    }
  };
  visit(schema, 0);
}

/** Validate every supported assertion locally, without coercion, defaults, network refs or regex. */
export function assertMcpToolInput(schema: JsonObject, input: JsonObject): void { assertMcpValue(schema, input, true); }

export function assertMcpToolOutput(schema: JsonObject, output: JsonValue): void { assertMcpValue(schema, output, false); }

function assertMcpValue(schema: JsonObject, input: JsonValue, objectRoot: boolean): void {
  assertMcpSchema(schema, objectRoot);
  const invalidInput = (): never => { throw new Error(objectRoot
    ? 'MCP tool arguments do not match the supported input JSON Schema.'
    : 'MCP tool structured output does not match the supported output JSON Schema.'); };
  try { checkJson(input, MAX_VALUE_BYTES); } catch { invalidInput(); }
  if (objectRoot && !object(input)) invalidInput();
  let work = 0;
  const step = (): void => { if (++work > MAX_WORK) invalidInput(); };
  const equal = (left: JsonValue, right: JsonValue): boolean => {
    step();
    if (left === right) return true;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
    if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equal(value, right[index]));
    const a = left as JsonObject; const b = right as JsonObject;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && equal(a[key], b[key]));
  };
  const typeMatches = (value: JsonValue, type: JsonValue): boolean => {
    if (type === 'null') return value === null;
    if (type === 'object') return object(value);
    if (type === 'array') return Array.isArray(value);
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    return typeof value === type;
  };
  const matches = (value: JsonValue, rule: Schema, depth: number): boolean => {
    step();
    if (depth > MAX_DEPTH) invalidInput();
    if (typeof rule === 'boolean') return rule;
    if (own(rule, 'type') && !(Array.isArray(rule.type) ? rule.type : [rule.type]).some(type => typeMatches(value, type))) return false;
    if (own(rule, 'const') && !equal(value, rule.const)) return false;
    if (own(rule, 'enum') && !(rule.enum as JsonValue[]).some(candidate => equal(value, candidate))) return false;
    if (own(rule, 'allOf') && !(rule.allOf as Schema[]).every(branch => matches(value, branch, depth + 1))) return false;
    if (own(rule, 'anyOf') && !(rule.anyOf as Schema[]).some(branch => matches(value, branch, depth + 1))) return false;
    if (own(rule, 'oneOf')) {
      let count = 0;
      for (const branch of rule.oneOf as Schema[]) { if (matches(value, branch, depth + 1) && ++count > 1) return false; }
      if (count !== 1) return false;
    }
    if (own(rule, 'not') && matches(value, rule.not as Schema, depth + 1)) return false;
    if (typeof value === 'number') {
      if (own(rule, 'minimum') && value < (rule.minimum as number) || own(rule, 'maximum') && value > (rule.maximum as number) || own(rule, 'exclusiveMinimum') && value <= (rule.exclusiveMinimum as number) || own(rule, 'exclusiveMaximum') && value >= (rule.exclusiveMaximum as number)) return false;
    }
    if (typeof value === 'string') {
      const length = [...value].length; // JSON Schema lengths count Unicode code points.
      if (own(rule, 'minLength') && length < (rule.minLength as number) || own(rule, 'maxLength') && length > (rule.maxLength as number)) return false;
    }
    if (Array.isArray(value)) {
      if (own(rule, 'minItems') && value.length < (rule.minItems as number) || own(rule, 'maxItems') && value.length > (rule.maxItems as number)) return false;
      if (own(rule, 'items')) for (const item of value) if (!matches(item, rule.items as Schema, depth + 1)) return false;
      if (rule.uniqueItems === true) for (let index = 0; index < value.length; index++) for (let previous = 0; previous < index; previous++) if (equal(value[index], value[previous])) return false;
    } else if (object(value)) {
      const keys = Object.keys(value);
      if (own(rule, 'minProperties') && keys.length < (rule.minProperties as number) || own(rule, 'maxProperties') && keys.length > (rule.maxProperties as number)) return false;
      if (own(rule, 'required') && (rule.required as string[]).some(key => !own(value, key))) return false;
      const properties = own(rule, 'properties') ? rule.properties as JsonObject : {};
      for (const key of keys) {
        if (own(properties, key)) { if (!matches(value[key], properties[key] as Schema, depth + 1)) return false; }
        else if (own(rule, 'additionalProperties') && !matches(value[key], rule.additionalProperties as Schema, depth + 1)) return false;
      }
    }
    return true;
  };
  if (!matches(input, schema, 0)) invalidInput();
}
