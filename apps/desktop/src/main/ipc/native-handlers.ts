import { z } from 'zod';
import type { Register } from './registration';
import { ConnectionStore, nativeConnectionInputSchema, nativeConnectionReadinessSchema, nativeConnectionReferenceSchema, nativeCredentialMutationSchema } from '../engines/native/connections';
import { NativeConnectionDiagnostics, nativeConnectionTestCancelSchema, nativeConnectionTestSchema } from '../engines/native/connection-diagnostics';
import { NativeConnectionModelCatalog, nativeConnectionModelListCancelSchema, nativeConnectionModelListSchema } from '../engines/native/connection-models';
import { NativeModelCapabilityService, nativeModelCapabilitySchema } from '../engines/native/model-capabilities';

// Zod's default unrecognized-key diagnostics can echo arbitrary supplied keys.
// These dedicated channels only return a fixed validation message, including for malformed secret input.
function privateInput<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return z.unknown().transform((input, context) => {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    context.addIssue({ code: 'custom', message: '模型连接请求格式无效，请检查输入并重试。' });
    return z.NEVER;
  });
}

/** Reuses the main root's trusted renderer / main-frame gate. No read-key channel exists. */
export function registerNativeHandlers(handle: Register, store: ConnectionStore, onChanged: () => void = () => {}, diagnostics = new NativeConnectionDiagnostics(store), modelCatalog = new NativeConnectionModelCatalog(store), modelCapabilities = new NativeModelCapabilityService(store, modelCatalog)): void {
  handle('native:connections-list', z.undefined(), () => store.list());
  handle('native:connections-upsert', privateInput(nativeConnectionInputSchema), input => { const result = store.upsert(input); onChanged(); return result; });
  handle('native:connections-remove', privateInput(nativeConnectionReferenceSchema), input => { store.remove(input); onChanged(); });
  handle('native:connections-credential', privateInput(nativeCredentialMutationSchema), input => { const result = store.setCredential(input); onChanged(); return result; });
  handle('native:connections-readiness', privateInput(nativeConnectionReadinessSchema), input => store.readiness(input.id, input.model));
  handle('native:connections-test', privateInput(nativeConnectionTestSchema), input => diagnostics.test(input));
  handle('native:connections-test-cancel', privateInput(nativeConnectionTestCancelSchema), input => diagnostics.cancel(input));
  handle('native:connections-models', privateInput(nativeConnectionModelListSchema), input => modelCatalog.list(input));
  handle('native:connections-models-cancel', privateInput(nativeConnectionModelListCancelSchema), input => modelCatalog.cancel(input));
  handle('native:connections-model-capabilities', privateInput(nativeModelCapabilitySchema), input => modelCapabilities.resolveReference(input));
}
