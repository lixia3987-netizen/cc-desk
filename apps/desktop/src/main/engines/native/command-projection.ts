import type { RunStoreRecord } from '@cc-desk/agent-node/run-store';
import type { NativeCommandSnapshot, NativeCommandView } from '../../../shared/chat';

const MAX_VISIBLE_COMMANDS = 64;

/** Only dedicated host events carry lifecycle facts; tool text and model prose are not parsed. */
export function projectNativeCommands(records: RunStoreRecord[]): NativeCommandSnapshot {
  const commands = new Map<string, NativeCommandView>();
  let omitted = 0;
  for (const record of records) {
    if (record.event.type !== 'command_lifecycle' || !record.identity) continue;
    const event = record.event.progress, key = `${record.identity.runId}:${event.commandId}`;
    if (event.status === 'prepared') {
      commands.set(key, {
        commandId: event.commandId, taskId: event.taskId, runId: record.identity.runId, toolCallId: record.event.toolCallId,
        command: structuredClone(event.command), status: event.status, preparedAt: event.at,
        timeoutMs: event.timeoutMs, maxOutputBytes: event.maxOutputBytes,
      });
      if (commands.size > MAX_VISIBLE_COMMANDS) { commands.delete(commands.keys().next().value!); omitted++; }
    } else {
      const command = commands.get(key);
      if (!command) continue;
      if (event.status === 'running') { command.status = 'running'; command.runningAt = event.at; }
      else { command.status = event.status; command.finishedAt = event.at; command.result = structuredClone(event.result); }
    }
  }
  return { items: [...commands.values()].reverse(), omitted };
}

/** Host ownership is transient, so a restart/finished run never restores a live-looking command. */
export function snapshotNativeCommands(saved: NativeCommandSnapshot, activeRunId?: string): NativeCommandSnapshot {
  const snapshot = structuredClone(saved);
  for (const command of snapshot.items) {
    if (['prepared', 'running'].includes(command.status) && command.runId !== activeRunId) {
      command.status = 'unknown'; command.missingTerminal = true;
    }
  }
  return snapshot;
}
