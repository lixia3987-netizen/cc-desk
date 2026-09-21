import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { authenticationSummary, diagnoseEnvironment, sanitizedOrigin, type DiagnosticRunner } from '../src/main/diagnostics';
import { claudeArguments, parseCapabilities } from '../src/main/commands';
import type { Session } from '../src/shared/types';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-diagnostics-'));
  const project = path.join(home, 'project with 空格');
  fs.mkdirSync(project);
  return {
    home, project,
    write(file: string, value: unknown) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    },
    cleanup() { fs.rmSync(home, { recursive: true, force: true }); },
  };
}
const fakeInvocation = { file: '/fake/claude', prefix: [] };
const calls: string[][] = [];
const loggedInRunner: DiagnosticRunner = async (_file, args) => {
  calls.push(args);
  if (args.includes('--version')) return { stdout: '2.1.278 (Claude Code)', exitCode: 0 };
  if (args.includes('--help')) return { stdout: 'Usage: claude auth status [options]\n--text Human readable', exitCode: 0 };
  return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'private@example.com', token: 'super-secret' }), exitCode: 0 };
};

test('URL sanitization drops credentials, path and query and rejects non HTTP URLs', () => {
  assert.equal(sanitizedOrigin('https://name:P%40ssw0rd@api.example.com:8443/secret?token=secret#private'), 'https://api.example.com:8443');
  assert.equal(sanitizedOrigin('file:///home/.credentials'), undefined);
  assert.equal(sanitizedOrigin('${API_ORIGIN}/mcp'), undefined);
  assert.equal(sanitizedOrigin({ url: 'https://example.com' }), undefined);
});

test('authentication status exposes only explicit consistent state and whitelisted method', () => {
  const value = authenticationSummary(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiKey: 'P@ssw0rd', email: 'me@secret.example' }), 0);
  assert.equal(value.state, 'authenticated');
  assert.equal(value.method, 'claude.ai');
  assert.equal(JSON.stringify(value).includes('P@ssw0rd'), false);
  assert.equal(JSON.stringify(value).includes('secret.example'), false);
  assert.equal(authenticationSummary('{"loggedIn":false,"authMethod":"secret-token"}', 1).state, 'unauthenticated');
  assert.equal(authenticationSummary('{"loggedIn":false,"authMethod":"secret-token"}', 1).method, undefined);
  assert.equal(authenticationSummary('{"loggedIn":true}', 1).state, 'unknown');
  assert.equal(authenticationSummary('{"loggedIn":false}', 0).state, 'unknown');
  assert.equal(authenticationSummary('Error: secret-token', 1).message.includes('secret-token'), false);
});

test('diagnostics discover scoped metadata without secrets, MCP execution or config mutation', async () => {
  const f = fixture(); calls.length = 0;
  try {
    const userSettings = path.join(f.home, '.claude', 'settings.json');
    f.write(userSettings, { env: { ANTHROPIC_API_KEY: 'user-secret', ANTHROPIC_BASE_URL: 'https://u:p@provider.example/api?key=hidden' }, apiKeyHelper: 'echo helper-secret' });
    f.write(path.join(f.project, '.claude', 'settings.json'), { env: { ANTHROPIC_AUTH_TOKEN: 'project-secret' } });
    f.write(path.join(f.project, '.claude', 'settings.local.json'), { env: { ANTHROPIC_BASE_URL: 'https://local-provider.example/v1' } });
    f.write(path.join(f.home, '.claude.json'), {
      oauthAccount: { accessToken: 'oauth-secret' },
      mcpServers: { global: { type: 'http', url: 'https://user:pass@mcp.example.com/private?token=url-secret', headers: { Authorization: 'header-secret' } } },
      projects: { [f.project]: { mcpServers: { local: { command: 'node', args: ['token-secret'], env: { PASSWORD: 'P@ssw0rd' } } } } },
    });
    f.write(path.join(f.project, '.mcp.json'), { mcpServers: { project: { type: 'stdio', command: 'npx', args: ['--token', 'arg-secret'] } } });
    f.write(path.join(f.home, '.claude', 'skills', 'review', 'SKILL.md'), 'Do not expose skill-secret');
    f.write(path.join(f.project, '.claude', 'skills', 'test', 'SKILL.md'), '---\nname: never-evaluate\n---\nskill-body-secret');
    f.write(path.join(f.project, '.claude', 'commands', 'legacy.md'), 'secret-command-content');
    const before = fs.readFileSync(userSettings, 'utf8');
    const report = await diagnoseEnvironment(f.project, 'claude', { home: f.home, env: { ANTHROPIC_API_KEY: 'env-secret' }, invocation: fakeInvocation, run: loggedInRunner });
    assert.equal(report.cli.installed, true);
    assert.equal(report.cli.runnable, true);
    assert.equal(report.cli.version, '2.1.278');
    assert.equal(report.auth.state, 'authenticated');
    assert.equal(report.provider.verified, false);
    assert.equal(report.provider.origin, undefined, 'conflicting providers are not misrepresented as the effective endpoint');
    assert.deepEqual(report.provider.origins, [{ origin: 'https://provider.example', source: 'user' }, { origin: 'https://local-provider.example', source: 'local' }]);
    assert.deepEqual(report.mcp.map(m => [m.name, m.scope, m.status]), [['global', 'user', 'configured'], ['project', 'project', 'configured'], ['local', 'local', 'configured']]);
    assert.deepEqual(report.mcp[2].envNames, ['PASSWORD']);
    assert.equal(report.mcp[0].origin, 'https://mcp.example.com');
    assert.deepEqual(report.skills.map(s => s.name), ['review', 'test', 'legacy']);
    assert.deepEqual(calls, [['--version'], ['auth', 'status', '--help'], ['auth', 'status']]);
    const serialized = JSON.stringify(report);
    for (const secret of ['user-secret', 'project-secret', 'oauth-secret', 'url-secret', 'header-secret', 'token-secret', 'P@ssw0rd', 'arg-secret', 'skill-secret', 'skill-body-secret', 'secret-command-content', 'env-secret', 'helper-secret', 'private@example.com', 'super-secret']) {
      assert.equal(serialized.includes(secret), false, `secret leaked: ${secret}`);
    }
    assert.equal(fs.readFileSync(userSettings, 'utf8'), before);
  } finally { f.cleanup(); }
});

test('unknown auth command never falls through to an interactive prompt', async () => {
  const f = fixture(); const invoked: string[][] = [];
  try {
    const report = await diagnoseEnvironment(f.project, '', { home: f.home, env: {}, invocation: fakeInvocation,
      run: async (_file, args) => { invoked.push(args); return { stdout: args.includes('--version') ? '1.0.0' : 'Usage: claude [options] [prompt]', exitCode: 0 }; } });
    assert.equal(report.auth.state, 'unsupported');
    assert.equal(invoked.length, 2);
  } finally { f.cleanup(); }
});

test('advertised auth JSON option is used and logged out exit 1 is parsed', async () => {
  const f = fixture(); const invoked: string[][] = [];
  try {
    const report = await diagnoseEnvironment(f.project, '', { home: f.home, env: {}, invocation: fakeInvocation,
      run: async (_file, args) => {
        invoked.push(args);
        if (args.includes('--version')) return { stdout: '2.1.0', exitCode: 0 };
        if (args.includes('--help')) return { stdout: 'Usage: claude auth status\n--json Output as JSON', exitCode: 0 };
        return { stdout: '{"loggedIn":false}', exitCode: 1 };
      } });
    assert.deepEqual(invoked.at(-1), ['auth', 'status', '--json']);
    assert.equal(report.auth.state, 'unauthenticated');
  } finally { f.cleanup(); }
});

test('configuration errors and process failures cannot echo credentials', async () => {
  const f = fixture();
  try {
    f.write(path.join(f.home, '.claude', 'settings.json'), '{"ANTHROPIC_API_KEY":"invalid-secret" BROKEN');
    const report = await diagnoseEnvironment(f.project, '', { home: f.home, env: {}, invocation: fakeInvocation,
      run: async () => { throw new Error('timeout stderr contains process-secret'); } });
    assert.equal(report.auth.state, 'unknown');
    assert.equal(report.cli.installed, true);
    assert.equal(report.cli.runnable, false);
    assert.equal(report.configs[0].status, 'invalid');
    assert.equal(JSON.stringify(report).includes('invalid-secret'), false);
    assert.equal(JSON.stringify(report).includes('process-secret'), false);
  } finally { f.cleanup(); }
});

test('custom configuration directory does not blend the default account MCP config', async () => {
  const f = fixture();
  try {
    const configDir = path.join(f.home, 'other-account');
    f.write(path.join(f.home, '.claude.json'), { mcpServers: { otherAccount: { command: 'node' } } });
    f.write(path.join(configDir, '.claude.json'), { mcpServers: { customAccount: { command: 'python' } } });
    f.write(path.join(configDir, 'settings.json'), { env: { ANTHROPIC_BASE_URL: 'https://custom.example/v1' } });
    const report = await diagnoseEnvironment(f.project, '', { home: f.home, env: { CLAUDE_CONFIG_DIR: configDir }, invocation: fakeInvocation, run: loggedInRunner });
    assert.deepEqual(report.mcp.map(item => item.name), ['customAccount']);
    assert.equal(report.provider.origin, 'https://custom.example');
  } finally { f.cleanup(); }
});

test('a previously started session cannot silently become a new session when transcript is missing', () => {
  const session: Session = { id: randomUUID(), projectId: randomUUID(), title: 'resume', kind: 'claude', cwd: '/tmp', claudeId: randomUUID(), started: true,
    model: '', effort: 'default', permissionMode: 'default', status: 'stopped', archived: false, createdAt: '', updatedAt: '' };
  const capabilities = parseCapabilities('--session-id UUID\n--resume ID\n--permission-mode default', 'claude', '2.1.278');
  assert.throws(() => claudeArguments(session, capabilities, false), /未找到原会话记录/);
  assert.equal(claudeArguments(session, capabilities, true)[0], '--resume');
  session.resumeFrom = randomUUID();
  assert.throws(() => claudeArguments(session, capabilities, false), /不会自动创建空白会话/);
});
