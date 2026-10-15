import { z } from 'zod';
import type { Register } from './registration';
import { NativeMcpConnectionStore, nativeMcpConnectionInputSchema, nativeMcpConnectionReferenceSchema, nativeMcpCredentialMutationSchema } from '../engines/native/mcp-connections';

/** 在这些涉及凭据的通道中，诊断不能包含未知键和无效值。 */
function privateInput<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return z.unknown().transform((input, context) => {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    context.addIssue({ code: 'custom', message: 'MCP 连接请求格式无效，请检查输入并重试。' });
    return z.NEVER;
  });
}

/** 可信渲染进程与主框架检查由组合根的 handle 提供。 */
export function registerNativeMcpHandlers(handle: Register, store: NativeMcpConnectionStore, onChanged: () => void = () => {}): void {
  handle('native:mcp-connections-list', privateInput(z.undefined()), () => store.list());
  handle('native:mcp-connections-upsert', privateInput(nativeMcpConnectionInputSchema), input => { const result = store.upsert(input); onChanged(); return result; });
  handle('native:mcp-connections-remove', privateInput(nativeMcpConnectionReferenceSchema), input => { store.remove(input); onChanged(); });
  handle('native:mcp-connections-credential', privateInput(nativeMcpCredentialMutationSchema), input => { const result = store.setCredential(input); onChanged(); return result; });
}
