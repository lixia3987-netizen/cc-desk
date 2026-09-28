import { createHash } from 'node:crypto';
import type { NativeTaskCodeLocation, NativeTaskEvidence, NativeTaskSnapshot } from '@cc-desk/contracts/native-task';
import { isSensitivePath, normalizeProjectPath, ProjectFiles } from '@cc-desk/agent-node/tools';

export interface CodeLocationInput {
  expectedRevision: number; path: string; expectedHash: string; startLine: number; endLine: number;
  stepIds: string[]; criterionIds: string[];
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Preserve original line endings; a terminal newline does not add a phantom line. */
export function extractCodeLines(content: string, startLine: number, endLine: number): string {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine >= 80) throw new Error('位置必须是连续的 1–80 行。');
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (endLine > lines.length) throw new Error('文件中不存在指定行。');
  const excerpt = lines.slice(startLine - 1, endLine).join('');
  if (Buffer.byteLength(excerpt) > 8192) throw new Error('原始片段超过 8192 字节，请选择更小范围。');
  return excerpt;
}

export async function readCodeLocation(files: ProjectFiles, input: CodeLocationInput, signal: AbortSignal): Promise<NativeTaskCodeLocation> {
  const relative = normalizeProjectPath(input.path);
  if (isSensitivePath(relative)) throw new Error('不能记录敏感路径。');
  const file = await files.read(relative, signal, 1024 * 1024);
  if (file.hash !== input.expectedHash) throw new Error('文件版本已改变，请重新 read_file 或 search。');
  const excerpt = extractCodeLines(file.content, input.startLine, input.endLine);
  return { path: file.path, startLine: input.startLine, endLine: input.endLine, fileHash: file.hash,
    fileBytes: file.bytes, excerpt, excerptHash: hash(excerpt) };
}

export function codeLocationEvidence(task: NativeTaskSnapshot, input: CodeLocationInput, location: NativeTaskCodeLocation, toolCallId: string): NativeTaskEvidence {
  if (!input.stepIds.length || new Set(input.stepIds).size !== input.stepIds.length || new Set(input.criterionIds).size !== input.criterionIds.length ||
      input.stepIds.some(id => !task.steps.some(step => step.id === id)) || input.criterionIds.some(id => !task.criteria.some(criterion => criterion.id === id))) throw new Error('位置关联的步骤或条件已改变，请先 read_task。');
  const workspace = task.workspace?.current;
  if (!workspace?.files.some(file => file.path === location.path && file.hash === location.fileHash && file.bytes === location.fileBytes)) throw new Error('该文件版本不在当前工作区观察中，请刷新后重新读取。');
  return {
    id: `location-${hash(`${task.taskId}\0${task.identity.runId}\0${toolCallId}`).slice(0, 40)}`,
    identity: { ...task.identity }, source: 'location', status: 'unverified',
    stepIds: [...input.stepIds], criterionIds: [...input.criterionIds], planRevision: task.planRevision, acceptanceRevision: task.acceptanceRevision,
    workspaceFingerprint: workspace.fingerprint, workspaceComplete: workspace.complete, toolCallId, location,
    reason: '宿主读取并保存的历史文件片段；用于定位与人工核查，不能证明当前文件状态或验收通过。', createdAt: new Date().toISOString(),
  };
}
