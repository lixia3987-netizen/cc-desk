import { z } from 'zod';
import type { NativeExecutionPolicy } from '@cc-desk/contracts/execution-ports';
import type { ToolPort } from '@cc-desk/agent-core';

const schema = z.object({
  toolPolicy: z.enum(['read_only', 'standard']),
  budget: z.object({ maxModelRequests: z.number().int().min(1).max(10000), maxToolCalls: z.number().int().min(1).max(10000),
    maxActiveMs: z.number().int().min(1).max(24 * 60 * 60_000) }).strict().optional(),
  parent: z.object({ sessionId: z.string().uuid(), runId: z.string().uuid(), taskId: z.string().uuid(),
    depth: z.number().int().min(1).max(1) }).strict().optional(),
}).strict();
export function parseNativeExecutionPolicy(value: unknown): NativeExecutionPolicy | undefined {
  return value === undefined ? undefined : schema.parse(value);
}
const READ_ONLY_TOOLS = new Set(['list_directory', 'read_file', 'search', 'find_files', 'update_plan', 'read_task',
  'record_code_location', 'ask_user', 'delegate_review']);
/** A host allowlist, checked again during every prepare/validate/execute; tool risk annotations alone are insufficient. */
export function restrictNativeTools(port: ToolPort, policy?: NativeExecutionPolicy): ToolPort {
  if (policy?.toolPolicy !== 'read_only') return port;
  const definitions = port.definitions.filter(item => READ_ONLY_TOOLS.has(item.name) && item.risk === 'read');
  const allowed = new Set(definitions.map(item => item.name));
  const assertAllowed = (name: string) => { if (!allowed.has(name)) throw new Error('此阶段仅允许本地只读工具，不能写文件、启动命令或调用外部服务。'); };
  return {
    definitions,
    prepare: (call, context) => { assertAllowed(call.name); return port.prepare(call, context); },
    validate: (prepared, context) => { assertAllowed(prepared.call.name); return port.validate(prepared, context); },
    execute: (prepared, context, approval) => { assertAllowed(prepared.call.name); return port.execute(prepared, context, approval); },
  };
}
