import { isPermissionMode } from '../shared/permissions';
import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Capabilities, Session } from '../shared/types';
import type { TaskState } from '../shared/chat';

/** Public HTTP hook events only. SessionStart does NOT support HTTP. */
export const PTY_HOOK_EVENTS = [
  'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
  'Stop', 'StopFailure', 'Notification', 'SessionEnd', 'PostModelSwitch', 'Elicitation', 'ElicitationResult'
] as const;
const permissionModes = ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const;
const hookInput = z.object({
  hook_event_name: z.enum(PTY_HOOK_EVENTS), session_id: z.uuid(),
  cwd: z.string().min(1).max(4096), agent_id: z.string().max(200).optional(),
  prompt_id: z.string().max(200).optional(), permission_mode: z.enum(permissionModes).optional(),
  tool_name: z.string().max(200).optional(), tool_use_id: z.string().max(200).optional(),
  notification_type: z.string().max(100).optional(), reason: z.string().max(100).optional(),
  to_model: z.string().min(1).max(200).refine(value => !/[\x00-\x1f]/.test(value)).optional()
});
export type PtyHookInput = z.infer<typeof hookInput>;
const MAX_BODY = 2 * 1024 * 1024;

/** Conservative documented baseline: PostModelSwitch was added in 2.1.251. */
export function supportsPtyHooks(capabilities: Capabilities): boolean {
  if (!capabilities.available || !capabilities.flags.includes('--settings')) return false;
  const match = capabilities.version.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$|\()/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || major === 2 && (minor > 1 || minor === 1 && patch >= 251);
}

/** Observes main-session events, without reading terminal output or making permission decisions. */
export class PtyHookObserver {
  private currentId: string;
  private retiredIds = new Set<string>();
  private awaitingIdentity = false;
  private promptId?: string;
  private tools = new Set<string>();
  private approvals = new Set<string>();
  private questions = new Set<string>();
  private eliciting = false;
  constructor(initialId: string) { this.currentId = initialId; }
  private clearTurn() { this.tools.clear(); this.approvals.clear(); this.questions.clear(); this.eliciting = false; }
  private toolState(): TaskState {
    return this.approvals.size ? 'waiting_approval' : this.questions.size || this.eliciting ? 'waiting_input' : this.tools.size ? 'tool_running' : 'thinking';
  }
  accept(input: PtyHookInput): Partial<Session> | null {
    // Subagents inherit hooks and share the parent session_id. They must not replace parent state.
    if (input.agent_id) return null;
    if (this.awaitingIdentity) {
      if (input.session_id === this.currentId) return null;
      this.retiredIds.delete(input.session_id); // Explicit /resume may return to an earlier conversation.
    } else if (this.retiredIds.has(input.session_id)) return null;
    const switched = input.session_id !== this.currentId;
    if (switched) {
      this.retiredIds.add(this.currentId);
      while (this.retiredIds.size > 64) this.retiredIds.delete(this.retiredIds.values().next().value!);
      this.currentId = input.session_id; this.promptId = undefined; this.clearTurn();
    }
    this.awaitingIdentity = false;
    const patch: Partial<Session> = { claudeId: input.session_id, terminalSync: 'synced', identityPending: false };
    if (input.permission_mode) {
      patch.observedPermissionMode = input.permission_mode;
      if (isPermissionMode(input.permission_mode)) patch.permissionMode = input.permission_mode;
    }
    if (input.hook_event_name === 'PostModelSwitch' && input.to_model) patch.model = input.to_model;
    if (input.hook_event_name === 'SessionEnd') {
      this.clearTurn();
      if (input.reason === 'clear' || input.reason === 'resume') {
        this.awaitingIdentity = true;
        patch.identityPending = true; patch.terminalSync = 'waiting'; patch.taskState = undefined;
      } else patch.taskState = 'idle';
      return patch;
    }
    if (input.hook_event_name === 'UserPromptSubmit') {
      this.promptId = input.prompt_id; this.clearTurn(); patch.taskState = 'thinking'; return patch;
    }
    // Ignore delayed state observations from a previous prompt; model/config metadata still applies.
    if (this.promptId && input.prompt_id && this.promptId !== input.prompt_id) return patch;
    const key = input.tool_use_id || input.tool_name || 'unknown';
    switch (input.hook_event_name) {
      case 'PreToolUse':
        this.tools.add(key);
        if (input.tool_name === 'AskUserQuestion') this.questions.add(key);
        patch.taskState = this.toolState(); break;
      case 'PermissionRequest':
        if (input.tool_name === 'AskUserQuestion') this.questions.add(key); else this.approvals.add(key);
        patch.taskState = this.toolState(); break;
      case 'PostToolUse': case 'PostToolUseFailure':
        this.tools.delete(key); this.approvals.delete(key); this.questions.delete(key);
        // PermissionRequest can omit tool_use_id; resolve the corresponding name fallback too.
        if (input.tool_name) { this.approvals.delete(input.tool_name); this.questions.delete(input.tool_name); }
        patch.taskState = this.toolState(); break;
      case 'Elicitation': this.eliciting = true; patch.taskState = this.toolState(); break;
      case 'ElicitationResult': this.eliciting = false; patch.taskState = this.toolState(); break;
      // Stop is the latest observed end-of-response event. Other user hooks can request another turn.
      case 'Stop': this.clearTurn(); patch.taskState = 'completed'; break;
      case 'StopFailure': this.clearTurn(); patch.taskState = 'error'; break;
      case 'Notification':
        if (input.notification_type === 'permission_prompt') patch.taskState = 'waiting_approval';
        else if (['idle_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'quota_auto_resume_stale'].includes(input.notification_type ?? '')) patch.taskState = 'waiting_input';
        else if (input.notification_type === 'quota_auto_resume_fired') patch.taskState = 'thinking';
        break;
    }
    return patch;
  }
}

export interface PtyHookBridge {
  /** JSON passed as one --settings argument, merged by Claude with existing settings. */
  settings: string;
  close(): Promise<void>;
}

/** The endpoint is local to one live PTY run; it cannot execute commands or grant permissions. */
export async function createPtyHookBridge(initialId: string, onPatch: (patch: Partial<Session>) => void): Promise<PtyHookBridge> {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from('Bearer ' + token);
  const observer = new PtyHookObserver(initialId);
  let closed = false;
  const server: Server = createServer((request, response) => {
    const reply = (status: number) => { if (!response.writableEnded) { response.writeHead(status, { 'Content-Length': '0', 'Cache-Control': 'no-store' }); response.end(); } };
    if (request.method !== 'POST' || request.url !== '/events' || request.headers.origin) { reply(404); request.resume(); return; }
    const authorization = Buffer.from(request.headers.authorization ?? '');
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) { reply(403); request.resume(); return; }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') { reply(415); request.resume(); return; }
    let size = 0; let oversized = false; const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > MAX_BODY) { oversized = true; chunks.length = 0; reply(413); return; }
      chunks.push(chunk);
    });
    request.on('error', () => reply(400));
    request.on('end', () => {
      if (oversized || closed) { reply(410); return; }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reply(400); return; }
      const parsed = hookInput.safeParse(input);
      if (!parsed.success) { reply(400); return; }
      const patch = observer.accept(parsed.data);
      // No hook decision, context injection, or permission change is ever returned to Claude.
      try { if (patch) onPatch(patch); } catch { /* Persistence/UI failures must not affect native approvals. */ }
      reply(200);
    });
  });
  server.requestTimeout = 4000; server.headersTimeout = 4000; server.keepAliveTimeout = 1000; server.maxConnections = 32;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', failed); resolve(); });
  });
  server.on('error', () => {}); server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('无法创建本地会话状态监听。'); }
  const handler = { type: 'http', url: `http://127.0.0.1:${address.port}/events`, headers: { Authorization: 'Bearer ' + token }, timeout: 1 };
  const settings = JSON.stringify({ hooks: Object.fromEntries(PTY_HOOK_EVENTS.map(event => [event, [{ hooks: [handler] }]])) });
  return {
    settings,
    close: () => new Promise<void>(resolve => {
      if (closed) { resolve(); return; }
      closed = true; server.close(() => resolve()); server.closeAllConnections();
    })
  };
}
