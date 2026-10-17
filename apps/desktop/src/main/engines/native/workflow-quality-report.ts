import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, type PreparedTool, type RunIdentity, type ToolExecutionContext, type ToolPort, type ToolResult } from '@cc-desk/agent-core';
import type { StoredRun } from '@cc-desk/agent-node/run-store';
import { assertNoModelCredential } from '@cc-desk/agent-node/responses-model';
import type { NativeQualityFinding, NativeQualityReport, NativeQualityReportDeclaration, NativeQualityRole, NativeQualityRoleState, NativeQualityValidationMode } from '@cc-desk/contracts/native-workflow-quality';

const encode = (value: unknown) => canonicalJson(JSON.parse(JSON.stringify(value)));
const digest = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex');
const relative = z.string().min(1).max(1024).refine(value => !/[\x00-\x1f\x7f\\<>:"|?*]/u.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..'));
const evidenceSchema = z.object({ toolCallId: z.string().min(1).max(256), path: relative, fileHash: z.string().regex(/^[a-f\d]{64}$/u), startLine: z.number().int().min(1).max(1000000), endLine: z.number().int().min(1).max(1000000) }).strict().refine(row => row.endLine >= row.startLine);
export const nativeQualityFindingSchema = z.object({ id: z.string().min(1).max(128), severity: z.enum(['blocking', 'high', 'medium', 'low']), title: z.string().trim().min(1).max(160),
  detail: z.string().trim().min(1).max(1000), evidence: z.array(evidenceSchema).min(1).max(4), reproduction: z.string().trim().min(1).max(1000) }).strict();
export const nativeQualityDeclarationSchema = z.object({ verdict: z.enum(['passed', 'changes_requested', 'unknown']), reviewedPaths: z.array(relative).min(1).max(24),
  limitations: z.array(z.string().trim().min(1).max(500)).max(8), findings: z.array(nativeQualityFindingSchema).max(8),
  resolutions: z.array(z.object({ findingId: z.string().min(1).max(128), status: z.enum(['resolved', 'unresolved', 'unknown']), evidence: z.array(evidenceSchema).min(1).max(4), explanation: z.string().trim().min(1).max(1000) }).strict()).max(24),
  verification: z.object({ status: z.enum(['executed', 'not_applicable', 'unknown']), commandToolCallIds: z.array(z.string().min(1).max(256)).max(32), reason: z.string().trim().min(1).max(1000) }).strict(),
}).strict().refine(value => new Set(value.findings.map(finding => finding.id)).size === value.findings.length &&
  new Set(value.resolutions.map(resolution => resolution.findingId)).size === value.resolutions.length, 'Quality finding and resolution identifiers must be unique within a report.');
export interface NativeQualityChildBinding {
  role: NativeQualityRole; round: number; snapshotCommit: string; workspaceFingerprint: string; deliveryDigest: string;
  validationMode: NativeQualityValidationMode; materialPaths: string[]; previousFindings: NativeQualityFinding[];
}
export interface NativeQualityReportTool extends ToolPort { report(): NativeQualityReport | undefined }

/** 不同角色常使用同名 P1-1；修复闭环必须绑定实际报告来源，不能靠模型局部 ID 合并问题。 */
export function nativeQualityFindingsForRound(roles: readonly NativeQualityRoleState[]): NativeQualityFinding[] {
  return roles.flatMap(role => (role.report?.declaration.findings ?? []).map(finding => ({ ...structuredClone(finding),
    id: `quality-${digest({ role: role.role, identity: role.identity, childId: role.childId, localFindingId: finding.id }).slice(0, 40)}` })));
}

function readObservations(run: StoredRun) {
  const result: Array<NativeQualityReport['materialReads'][number] & { complete: boolean; content?: string; startLine?: number; fileBytes?: number }> = [];
  for (const tool of run.tools) {
    const prepared = tool.prepared?.prepared, actual = tool.completed?.result, output = actual?.output;
    if (!prepared || actual?.status !== 'completed' || actual.truncated || !output || typeof output !== 'object' || Array.isArray(output)) continue;
    if (tool.call.name === 'read_file' && output.truncated !== true && output.path === prepared.input.path && typeof output.path === 'string' &&
        typeof output.hash === 'string' && /^[a-f\d]{64}$/u.test(output.hash) && typeof output.content === 'string') {
      result.push({ toolCallId: tool.call.id, path: output.path, fileHash: output.hash,
        complete: false, ...(prepared.input.startByte === undefined && typeof output.bytes === 'number' && Number.isSafeInteger(output.bytes) && output.bytes >= 0 ?
          { content: output.content, startLine: Number(prepared.input.startLine ?? 1), fileBytes: output.bytes } : {}) });
    } else if (tool.call.name === 'search' && Array.isArray(output.matches)) {
      for (const match of output.matches) if (match && typeof match === 'object' && !Array.isArray(match) && typeof match.path === 'string' &&
          typeof match.hash === 'string' && /^[a-f\d]{64}$/u.test(match.hash) && match.hashStatus === 'complete' && match.textTruncated !== true && typeof match.text === 'string') {
        result.push({ toolCallId: tool.call.id, path: match.path, fileHash: match.hash, complete: false });
      }
    }
  }
  // 大文件允许按真实行范围分块读取。只有同版本全部行重建出的 UTF-8 字节数与完整
  // SHA-256 都相等，整组才算完整覆盖。头尾、缺行、换版本及冲突重叠均不能补成通过。
  const groups = new Map<string, typeof result>();
  for (const row of result) if (row.content !== undefined && row.startLine !== undefined && row.fileBytes !== undefined) {
    const key = `${row.path}\0${row.fileHash}\0${row.fileBytes}`;
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  for (const group of groups.values()) {
    const lines = new Map<number, string>(); let inconsistent = false, maximum = 0;
    for (const row of group) {
      const observed = row.content!.split('\n');
      for (let offset = 0; offset < observed.length; offset++) {
        const line = row.startLine! + offset;
        if (!Number.isSafeInteger(line) || line < 1 || line > 1000000) { inconsistent = true; break; }
        const prior = lines.get(line);
        if (prior !== undefined && prior !== observed[offset]) { inconsistent = true; break; }
        lines.set(line, observed[offset]); maximum = Math.max(maximum, line);
      }
      if (inconsistent) break;
    }
    if (inconsistent || lines.size !== maximum) continue;
    const content = Array.from({ length: maximum }, (_, index) => lines.get(index + 1)!).join('\n');
    if (Buffer.byteLength(content) !== group[0].fileBytes || createHash('sha256').update(content).digest('hex') !== group[0].fileHash) continue;
    for (const row of group) row.complete = true;
  }
  return result;
}

/** 所有证据来自宿主账本，而非 summary、stdout 中的“通过”文字或模型填写的身份。 */
export function nativeQualityHostEvidence(run: StoredRun) {
  // 搜索命中与局部读取可以定位问题，却不能声称完整覆盖整个材料。
  const materialReads: NativeQualityReport['materialReads'] = readObservations(run).filter(row => row.complete).map(({ toolCallId, path, fileHash }) => ({ toolCallId, path, fileHash }));
  const commandReceipts: NativeQualityReport['commandReceipts'] = [];
  const observedVersions = new Map<string, string>();
  const version = (file: unknown, fileHash: unknown) => {
    if (typeof file !== 'string' || typeof fileHash !== 'string' || !/^[a-f\d]{64}$/u.test(fileHash)) return;
    const previous = observedVersions.get(file);
    if (previous && previous !== fileHash) throw new Error('quality_material_version_changed');
    observedVersions.set(file, fileHash);
  };
  for (const tool of run.tools) {
    const prepared = tool.prepared?.prepared, result = tool.completed?.result, output = result?.output;
    if (!prepared || !output || typeof output !== 'object' || Array.isArray(output)) continue;
    if (result?.status === 'completed' && tool.call.name === 'read_file' && prepared.input.path === output.path) version(output.path, output.hash);
    if (result?.status === 'completed' && tool.call.name === 'search' && Array.isArray(output.matches)) for (const match of output.matches) {
      if (match && typeof match === 'object' && !Array.isArray(match) && match.hashStatus === 'complete') version(match.path, match.hash);
    }
    if (prepared.definition.risk !== 'command' || !['run_command', 'start_command'].includes(tool.call.name)) continue;
    const progress = tool.commandProgress?.at(-1), terminal = progress && 'result' in progress ? progress.result : undefined;
    const actual = terminal ?? output;
    const exitCode = typeof actual.exitCode === 'number' ? actual.exitCode : null;
    const successful = (terminal ? progress?.status === 'finished' : result?.status === 'completed') && exitCode === 0 && actual.cleanup === 'released' &&
      actual.cancelled === false && actual.timedOut === false && actual.signal === null && !actual.truncated && !result?.truncated;
    commandReceipts.push({ toolCallId: tool.call.id, exitCode, successful });
  }
  if (materialReads.length > 64 || commandReceipts.length > 64) throw new Error('quality_evidence_limit');
  return { materialReads, commandReceipts };
}

export function createNativeQualityReportTool(options: { identity: RunIdentity; taskId: string; binding: NativeQualityChildBinding; forbiddenValues: readonly string[];
  assertOwnership(): Promise<void>; readRun(): StoredRun | undefined }): NativeQualityReportTool {
  const identityKey = encode(options.identity), states = new Map<string, { prepared: PreparedTool; maximum: number; result?: ToolResult }>();
  const binding = structuredClone(options.binding);
  let report: NativeQualityReport | undefined;
  const guard = async (context: ToolExecutionContext) => {
    if (context.signal.aborted || encode(context.identity) !== identityKey) throw new Error('Quality report identity changed.');
    await options.assertOwnership();
    const run = options.readRun();
    if (context.signal.aborted || !run || run.status !== 'active' || encode(run.identity) !== identityKey || run.configuration.nativeTaskId !== options.taskId) throw new Error('Quality report run is unavailable.');
    return run;
  };
  const definition = { name: 'submit_quality_report', risk: 'read' as const,
    description: 'Submit the structured independent quality report. The host binds your role, fresh child identity, round and immutable workspace version. Read every declared material completely using actual read_file tools. For large files use contiguous line ranges until the entire same-hash file is covered; the host reconstructs its exact bytes and hash. Search alone is only finding-location evidence. Evidence entries must reference successful reads/searches and actual full file hashes. Report limitations and unresolved findings honestly. The verifier in commands mode must cite successful finished run_command/start_command calls; startup or text is not test evidence. Static mode must use not_applicable with its actual reason. Every previous blocking/high finding needs a fresh complete-material evidence-backed resolution. This submission does not grant permissions or manual acceptance.',
    inputSchema: z.toJSONSchema(nativeQualityDeclarationSchema) as unknown as import('@cc-desk/agent-core').JsonObject };
  const stateFor = (prepared: PreparedTool, context: ToolExecutionContext) => {
    const state = states.get(prepared.call.id);
    if (!state || state.maximum !== context.maxOutputBytes || encode(state.prepared) !== encode(prepared) || context.policyRevision !== prepared.policyRevision) throw new Error('Quality report preparation changed.');
    return state;
  };
  const validateDeclaration = (declaration: NativeQualityReportDeclaration, run: StoredRun) => {
    const actual = nativeQualityHostEvidence(run);
    const observations = readObservations(run);
    if (actual.materialReads.length > 64 || actual.commandReceipts.length > 64) throw new Error('Quality evidence exceeds the explicit report scope; it cannot be silently truncated.');
    if (new Set(declaration.findings.map(finding => finding.id)).size !== declaration.findings.length ||
        new Set(declaration.resolutions.map(row => row.findingId)).size !== declaration.resolutions.length) throw new Error('Quality finding and resolution identifiers must be unique within a report.');
    if (binding.materialPaths.some(file => !declaration.reviewedPaths.includes(file) || !actual.materialReads.some(read => read.path === file))) throw new Error('Quality material read evidence is missing.');
    if (declaration.reviewedPaths.some(file => !actual.materialReads.some(read => read.path === file))) throw new Error('Quality coverage lacks real reads.');
    const references = [...declaration.findings.flatMap(finding => finding.evidence), ...declaration.resolutions.flatMap(row => row.evidence)];
    for (const reference of references) {
      const observed = observations.find(read => read.toolCallId === reference.toolCallId && read.path === reference.path && read.fileHash === reference.fileHash);
      if (!observed) throw new Error('Quality finding evidence was not observed.');
      const read = run.tools.find(tool => tool.call.id === reference.toolCallId), prepared = read?.prepared?.prepared, output = read?.completed?.result.output;
      if (!prepared || !output || typeof output !== 'object' || Array.isArray(output)) throw new Error('Quality evidence is unavailable.');
      if (read!.call.name === 'read_file') {
        if (prepared.input.startByte !== undefined) throw new Error('Byte-range reads cannot establish finding line evidence.');
        const start = Number(prepared.input.startLine ?? 1), lines = typeof output.content === 'string' ? output.content.split('\n').length - (output.content.endsWith('\n') ? 1 : 0) : 0;
        if (reference.startLine < start || reference.endLine >= start + Math.max(1, lines)) throw new Error('Quality finding line evidence is out of range.');
      } else if (!Array.isArray(output.matches) || !output.matches.some(match => match && typeof match === 'object' && !Array.isArray(match) && match.path === reference.path && match.hash === reference.fileHash && match.line === reference.startLine && reference.startLine === reference.endLine)) throw new Error('Quality search line evidence is out of range.');
    }
    const previous = binding.previousFindings.filter(finding => ['blocking', 'high'].includes(finding.severity));
    if (declaration.resolutions.some(resolution => resolution.evidence.some(reference => !actual.materialReads.some(read => read.toolCallId === reference.toolCallId && read.path === reference.path && read.fileHash === reference.fileHash)))) throw new Error('Finding resolutions require fresh complete-file read evidence.');
    if (previous.some(finding => !declaration.resolutions.some(row => row.findingId === finding.id))) throw new Error('Previous quality findings require explicit resolutions.');
    if (declaration.verification.commandToolCallIds.some(id => !actual.commandReceipts.some(receipt => receipt.toolCallId === id))) throw new Error('Quality command receipt is unavailable.');
    if (binding.role === 'verifier' && binding.validationMode === 'commands' && declaration.verdict === 'passed' &&
        (declaration.verification.status !== 'executed' || !declaration.verification.commandToolCallIds.length || actual.commandReceipts.some(row => !row.successful) ||
          declaration.verification.commandToolCallIds.some(id => !actual.commandReceipts.some(row => row.toolCallId === id && row.successful)))) throw new Error('Successful independent command evidence is required; failed, cancelled or unknown commands cannot be omitted.');
    if (binding.validationMode === 'static' && (declaration.verification.status !== 'not_applicable' || declaration.verification.commandToolCallIds.length)) throw new Error('Static review cannot claim executable validation.');
    if (binding.role !== 'verifier' && declaration.verification.status === 'executed') throw new Error('Read-only reviewers cannot claim executable validation.');
    return actual;
  };
  return {
    definitions: [definition], report: () => report ? structuredClone(report) : undefined,
    async prepare(call, context) {
      if (call.name !== definition.name || !call.id || call.id.length > 256 || Buffer.byteLength(call.arguments) > 8192 || states.size >= 16) throw new Error('Invalid quality report call.');
      const run = await guard(context), existing = states.get(call.id);
      if (existing) { if (encode(existing.prepared.call) !== encode(call)) throw new Error('Quality report call ID reused.'); stateFor(existing.prepared, context); return structuredClone(existing.prepared); }
      const input = nativeQualityDeclarationSchema.parse(JSON.parse(call.arguments));
      assertNoModelCredential(input, options.forbiddenValues); validateDeclaration(input, run);
      const prepared: PreparedTool = { call: structuredClone(call), definition: structuredClone(definition), input: JSON.parse(JSON.stringify(input)), inputDigest: digest(input),
        policyRevision: context.policyRevision, requiresApproval: false, preconditions: { identity: JSON.parse(identityKey), binding: JSON.parse(encode(binding)), taskId: options.taskId } };
      states.set(call.id, { prepared, maximum: context.maxOutputBytes }); return structuredClone(prepared);
    },
    async validate(prepared, context) { stateFor(prepared, context); const run = await guard(context); validateDeclaration(nativeQualityDeclarationSchema.parse(prepared.input), run); },
    async execute(prepared, context) {
      const state = stateFor(prepared, context); if (state.result) return structuredClone(state.result);
      const run = await guard(context), declaration = nativeQualityDeclarationSchema.parse(prepared.input), actual = validateDeclaration(declaration, run);
      report = { version: 1, role: binding.role, round: binding.round, identity: structuredClone(options.identity), taskId: options.taskId,
        snapshotCommit: binding.snapshotCommit, workspaceFingerprint: binding.workspaceFingerprint, deliveryDigest: binding.deliveryDigest, declaration, ...actual, submittedAt: new Date().toISOString() };
      if (Buffer.byteLength(encode(report)) > 8192) { report = undefined; throw new Error('Quality report exceeds evidence budget.'); }
      assertNoModelCredential(report, options.forbiddenValues);
      state.result = { status: 'completed', output: { submitted: true, role: binding.role, round: binding.round, automaticAcceptance: false, manualAcceptance: false } };
      return structuredClone(state.result);
    },
  };
}
