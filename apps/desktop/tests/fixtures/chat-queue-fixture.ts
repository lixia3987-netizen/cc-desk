import { desktopRoot } from '../helpers/paths';
import { expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppState, Session } from '../../src/shared/types';
import { electronLaunchArgs } from '../helpers/electron-launch';

export interface QueueRecord {
  event: 'start' | 'prompt' | 'interrupt' | 'result' | 'signal' | 'violation';
  session: string; pid: number; text?: string; commandId?: string;
  content?: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>;
  interrupted?: boolean; failed?: boolean;
}

/** Real Electron, IPC, child processes and stream-json; only the remote model is replaced. */
export async function chatQueueWorkspace() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-chat-queue-')));
  const data = path.join(directory, 'data'), projectPath = path.join(directory, '项目 with spaces');
  const prefix = path.join(directory, 'npm CLI'), pkg = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
  const log = path.join(directory, 'protocol.jsonl'), commands = path.join(directory, 'commands.json');
  const attachment = path.join(directory, 'queue-image.png');
  await Promise.all([fs.mkdir(data), fs.mkdir(projectPath), fs.mkdir(pkg, { recursive: true }), fs.writeFile(log, ''), fs.writeFile(commands, '[]')]);
  await fs.writeFile(attachment, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64'));
  const node = path.join(prefix, process.platform === 'win32' ? 'node.exe' : 'node');
  if (process.platform === 'win32') await fs.copyFile(process.execPath, node); else await fs.symlink(process.execPath, node);
  await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'cli.js' } }));
  await fs.writeFile(path.join(pkg, 'cli.js'), `const logFile = ${JSON.stringify(log)}, commandsFile = ${JSON.stringify(commands)};\n` + String.raw`
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('Claude Code fixture 2.1.280'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--session-id --resume --permission-mode --model --effort --print --input-format --output-format --verbose --permission-prompt-tool --include-partial-messages'); process.exit(0); }
if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'fixture' })); process.exit(0); }
const flag = name => process.argv[process.argv.indexOf(name) + 1];
const session = process.argv.includes('--resume') ? flag('--resume') : flag('--session-id');
const record = value => fs.appendFileSync(logFile, JSON.stringify({ session, pid: process.pid, ...value }) + '\n');
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const transcriptDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture');
fs.mkdirSync(transcriptDir, { recursive: true });
let active, turn = 0, cursor = JSON.parse(fs.readFileSync(commandsFile, 'utf8')).length;
record({ event: 'start' });
const done = failed => {
  if (!active) { record({ event: 'violation', text: 'completion without a prompt' }); return; }
  const current = active; active = undefined;
  const text = (failed ? '任务失败：' : current.interrupted ? '已中断：' : '已完成：') + current.text;
  record({ event: 'result', text: current.text, interrupted: current.interrupted, failed });
  output({ type: 'assistant', message: { id: 'reply-' + process.pid + '-' + turn, content: [{ type: 'text', text }] } });
  output({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', session_id: session, result: text, is_error: failed, num_turns: 1 });
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    if (frame.request.subtype === 'interrupt') {
      record({ event: 'interrupt', text: active?.text });
      if (active) active.interrupted = true;
    }
    output({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
    // The interrupt control acknowledgement is intentionally NOT a turn result.
    // A separate test signal releases that result, catching overlapping prompts.
    return;
  }
  if (frame.type !== 'user') return;
  const content = typeof frame.message.content === 'string' ? [{ type: 'text', text: frame.message.content }] : frame.message.content;
  const text = content.find(value => value.type === 'text')?.text ?? '';
  if (active) record({ event: 'violation', text: 'overlapping prompts: ' + active.text + ' -> ' + text });
  active = { text, interrupted: false }; ++turn;
  record({ event: 'prompt', text, content });
  fs.appendFileSync(path.join(transcriptDir, session + '.jsonl'), JSON.stringify({ type: 'user', sessionId: session, cwd: process.cwd(), message: { role: 'user', content: text } }) + '\n');
  output({ type: 'system', subtype: 'init', session_id: session, model: 'fixture-model', permissionMode: 'default' });
});
// File commands are a deterministic gate, not a simulated completion timeout.
const timer = setInterval(() => {
  let commands; try { commands = JSON.parse(fs.readFileSync(commandsFile, 'utf8')); } catch { return; }
  for (; cursor < commands.length; cursor++) {
    const command = commands[cursor]; if (command.session !== session) continue;
    if (command.action === 'complete' || command.action === 'release-interrupt') done(false);
    else if (command.action === 'fail') done(true);
    record({ event: 'signal', commandId: command.id });
    if (command.action === 'crash') process.exit(23);
  }
}, 20);
process.stdin.on('end', () => { clearInterval(timer); process.exit(0); });
`);
  const cli = path.join(prefix, 'claude.cmd');
  await fs.writeFile(cli, '@echo off\r\nexit /b 99\r\n', { mode: 0o755 });
  const now = new Date().toISOString(), project = { id: randomUUID(), name: '消息队列项目', path: projectPath, createdAt: now };
  const sessions: Session[] = ['队列会话 A', '队列会话 B'].map(title => ({
    id: randomUUID(), execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() },
    projectId: project.id, title, titleSource: 'manual', kind: 'agent', cwd: projectPath,
    started: false, model: '', effort: 'default', permissionMode: 'default', status: 'idle', archived: false, createdAt: now, updatedAt: now,
  }));
  const state: AppState = { version: 2, projects: [project], sessions, selectedSessionId: sessions[0].id,
    settings: { claudePath: cli, shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, chatFontFamily: 'system', uiFontFamily: 'system' } };
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify(state));
  const records = async (): Promise<QueueRecord[]> => (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const sent: Array<{ id: string; session: string; action: string }> = [];
  return {
    sessions, attachment, configDirectory: path.join(directory, 'claude-config'),
    launch: () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data, CLAUDE_CONFIG_DIR: path.join(directory, 'claude-config') } }),
    records,
    prompts: async (session: Session) => (await records()).filter(value => value.event === 'prompt' && value.session === session.execution.conversationId).map(value => value.text),
    signal: async (session: Session, action: 'complete' | 'fail' | 'release-interrupt' | 'barrier' | 'crash') => {
      const command = { id: randomUUID(), session: session.execution.conversationId!, action };
      sent.push(command); await fs.writeFile(commands, JSON.stringify(sent));
      await expect.poll(async () => (await records()).some(value => value.event === 'signal' && value.commandId === command.id)).toBe(true);
    },
    dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

export async function closeQueueApp(app: ElectronApplication) {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
  await app.close();
}
