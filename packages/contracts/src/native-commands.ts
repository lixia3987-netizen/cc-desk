import { nativeChangeSetUtf8Bytes } from './native-changes.js';

export const NATIVE_COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;
export const NATIVE_COMMAND_MAX_PER_RUN = 8;
export interface NativeCommandDescriptor { executable: string; argv: string[]; cwd: string }
export interface NativeCommandResult {
  exitCode: number | null; signal: string | null;
  stdout: string; stderr: string; outputBytes: number; truncated: boolean;
  timedOut: boolean; cancelled: boolean; cleanup: 'released' | 'cleanup_failed'; error?: string;
}
/** Host-only facts. IDs are opaque application handles, never operating-system process IDs. */
export type NativeCommandLifecycleEvent =
  | { commandId: string; status: 'prepared'; taskId: string; command: NativeCommandDescriptor; timeoutMs: number; maxOutputBytes: number; at: string }
  | { commandId: string; status: 'running'; at: string }
  | { commandId: string; status: 'finished' | 'unknown'; at: string; result: NativeCommandResult };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => object(value) && Object.keys(value).every(key => keys.includes(key));
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const text = (value: unknown, max: number, allowEmpty = false): value is string => typeof value === 'string' && (allowEmpty || value.length > 0) && nativeChangeSetUtf8Bytes(value) <= max;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const cwd = (value: unknown): value is string => text(value, 4096) && !/[\x00-\x1f\x7f\\:]/.test(value) && !value.startsWith('/') && (value === '.' || value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)));

export function isNativeCommandResult(value: unknown): value is NativeCommandResult {
  if (!exact(value, ['exitCode', 'signal', 'stdout', 'stderr', 'outputBytes', 'truncated', 'timedOut', 'cancelled', 'cleanup', 'error'])) return false;
  if (!(value.exitCode === null || integer(value.exitCode, -2147483648, 4294967295)) || !(value.signal === null || typeof value.signal === 'string' && /^SIG[A-Z0-9]{1,24}$/.test(value.signal))) return false;
  if (!text(value.stdout, NATIVE_COMMAND_MAX_OUTPUT_BYTES, true) || !text(value.stderr, NATIVE_COMMAND_MAX_OUTPUT_BYTES, true) || nativeChangeSetUtf8Bytes(value.stdout) + nativeChangeSetUtf8Bytes(value.stderr) > NATIVE_COMMAND_MAX_OUTPUT_BYTES) return false;
  if (!integer(value.outputBytes, 0, Number.MAX_SAFE_INTEGER) || typeof value.truncated !== 'boolean' || typeof value.timedOut !== 'boolean' || typeof value.cancelled !== 'boolean' || !['released', 'cleanup_failed'].includes(String(value.cleanup))) return false;
  return value.error === undefined || text(value.error, 2048, true);
}

export function isNativeCommandLifecycleEvent(value: unknown): value is NativeCommandLifecycleEvent {
  try {
    if (!object(value) || !uuid(value.commandId) || typeof value.at !== 'string' || value.at.length !== 24 || new Date(value.at).toISOString() !== value.at) return false;
    if (value.status === 'prepared') {
      if (!exact(value, ['commandId', 'status', 'taskId', 'command', 'timeoutMs', 'maxOutputBytes', 'at']) || !text(value.taskId, 256) || /[\x00-\x1f\x7f]/.test(value.taskId) || !exact(value.command, ['executable', 'argv', 'cwd'])) return false;
      const command = value.command;
      return text(command.executable, 4096) && !/[\x00-\x1f\x7f]/.test(command.executable) && cwd(command.cwd) && Array.isArray(command.argv) && command.argv.length <= 256 && command.argv.every(arg => text(arg, 32768, true) && !arg.includes('\0')) && nativeChangeSetUtf8Bytes(JSON.stringify(command.argv)) <= 32768 && integer(value.timeoutMs, 1, 3_600_000) && integer(value.maxOutputBytes, 256, NATIVE_COMMAND_MAX_OUTPUT_BYTES);
    }
    if (value.status === 'running') return exact(value, ['commandId', 'status', 'at']);
    return (value.status === 'finished' || value.status === 'unknown') && exact(value, ['commandId', 'status', 'at', 'result']) && isNativeCommandResult(value.result) && (value.status !== 'finished' || value.result.cleanup === 'released');
  } catch { return false; }
}
