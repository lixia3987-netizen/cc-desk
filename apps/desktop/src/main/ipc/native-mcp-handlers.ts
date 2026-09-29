import { z } from 'zod';
import type { Register } from './registration';
import { NativeMcpConnectionStore, nativeMcpConnectionInputSchema, nativeMcpConnectionReferenceSchema, nativeMcpCredentialMutationSchema } from '../engines/native/mcp-connections';

/** Unknown keys and invalid values must not appear in diagnostics on these credential-facing channels. */
function privateInput<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return z.unknown().transform((input, context) => {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    context.addIssue({ code: 'custom', message: 'MCP 连接请求格式无效，请检查输入并重试。' });
    return z.NEVER;
  });
}

/** Trusted renderer / main-frame checks are supplied by the composition root's handle. */
export function registerNativeMcpHandlers(handle: Register, store: NativeMcpConnectionStore, onChanged: () => void = () => {}): void {
  handle('native:mcp-connections-list', privateInput(z.undefined()), () => store.list());
  handle('native:mcp-connections-upsert', privateInput(nativeMcpConnectionInputSchema), input => { const result = store.upsert(input); onChanged(); return result; });
  handle('native:mcp-connections-remove', privateInput(nativeMcpConnectionReferenceSchema), input => { store.remove(input); onChanged(); });
  handle('native:mcp-connections-credential', privateInput(nativeMcpCredentialMutationSchema), input => { const result = store.setCredential(input); onChanged(); return result; });
}
