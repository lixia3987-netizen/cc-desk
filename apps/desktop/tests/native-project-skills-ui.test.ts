import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NativeProjectSkillChoices, NativeProjectSkills, toggleProjectSkill } from '../src/renderer/components/NativeProjectSkills';
import { NativeInstructionSources, NativeSourcePreview } from '../src/renderer/components/NativeInstructionInspector';
import { SessionConfig } from '../src/renderer/SessionConfig';
import type { Session } from '../src/shared/types';
import type { ExecutionDescriptor } from '../src/shared/execution';
import type { NativeSkillsListResult } from '../src/shared/native-skills';

const fail = () => { throw new Error('Rendering must not read, save, or change project Skills'); };
const agentPath = '.agents/skills/review/SKILL.md';
const claudePath = '.claude/skills/review/SKILL.md';
const result: NativeSkillsListResult = {
  entries: [agentPath, claudePath].map(path => ({ path, name: 'review', hash: 'a'.repeat(64), bytes: 80 })),
  issues: [], truncated: false,
};
const renderChoices = (selected: string[], data: NativeSkillsListResult | undefined = result, disabled = false) => renderToStaticMarkup(createElement(NativeProjectSkillChoices, {
  selected, result: data, disabled, onChange: fail,
}));

test('project Skills start with explicit discovery and preserve previously selected paths before reading', () => {
  // No window/desktop bridge exists in this test: initial rendering must not use one.
  const initial = renderToStaticMarkup(createElement(NativeProjectSkills, { sessionId: 'one', selected: [], onChange: fail }));
  assert.match(initial, /type="button"[^>]*>读取项目 Skills<\/button>/);
  assert.match(initial, /已选 0 \/ 16/);
  assert.doesNotMatch(initial, /type="checkbox"/);
  assert.match(initial, /默认不启用。保存配置后下一轮生效/);
  assert.match(initial, /读取目录不会请求模型/);
  const saved = renderToStaticMarkup(createElement(NativeProjectSkills, { sessionId: 'one', selected: [agentPath], onChange: fail }));
  assert.match(saved, /已保存的选择，尚未读取项目目录/);
  assert.match(saved, /type="checkbox"[^>]*checked=""/);
  assert.doesNotMatch(saved, /type="checkbox"[^>]*disabled=""/);
});

test('same-named Skills remain distinct by complete path and metadata never changes the selection', () => {
  const selected = [claudePath];
  const markup = renderChoices(selected);
  assert.equal((markup.match(/<strong>review<\/strong>/g) ?? []).length, 2);
  assert.match(markup, /aria-label="\.agents\/skills\/review\/SKILL.md"\/>/);
  assert.match(markup, /aria-label="\.claude\/skills\/review\/SKILL.md" checked=""/);
  assert.deepEqual(selected, [claudePath]);
  assert.deepEqual(toggleProjectSkill(selected, agentPath), [claudePath, agentPath]);
  assert.deepEqual(toggleProjectSkill([claudePath, agentPath], agentPath), [claudePath]);
});

test('missing, rejected, and truncated selected paths remain removable and errors render as text', () => {
  const missing = '.agents/skills/removed/SKILL.md';
  const rejected = '.claude/skills/rejected/SKILL.md';
  const selected = [missing, rejected];
  const markup = renderChoices(selected, { entries: [], issues: [{ path: rejected, message: '<script>blocked</script>' }], truncated: true });
  assert.equal((markup.match(/checked=""/g) ?? []).length, 2);
  assert.doesNotMatch(markup, /disabled=""|<script>/);
  assert.match(markup, /不在默认目录列表或当前不可用，已保留选择；可预览检查或取消勾选/);
  assert.match(markup, /&lt;script&gt;blocked&lt;\/script&gt;/);
  assert.match(markup, /目录列表已达读取上限/);
  assert.deepEqual(toggleProjectSkill(selected, rejected), [missing]);
  assert.deepEqual(selected, [missing, rejected]);
});

test('custom source and instruction inspection start only on explicit action and stay read-only', () => {
  const markup = renderToStaticMarkup(createElement(NativeProjectSkills, { sessionId: 'one', selected: ['tools/review/SKILL.md'], onChange: fail }));
  assert.match(markup, /其他 Skill 路径/);
  assert.match(markup, /读取 Skill 预览/);
  assert.match(markup, /aria-label="预览 tools\/review\/SKILL.md"/);
  assert.match(markup, /指令目标目录/);
  assert.match(markup, /读取适用指令/);
  assert.match(markup, /仅按明确路径读取，不扫描其他目录或 HOME/);
  assert.match(markup, /修改请使用编辑器/);
  assert.doesNotMatch(markup, /<pre>/);
  const locked = renderToStaticMarkup(createElement(NativeProjectSkills, { sessionId: 'one', selected: ['tools/review/SKILL.md'], onChange: fail, disabled: true }));
  assert.match(locked, /disabled=""[^>]*>读取 Skill 预览/);
  assert.match(locked, /disabled=""[^>]*>读取适用指令/);
});

test('source previews render exact literal text with escaped HTML, identity metadata and instruction order', () => {
  const content = '<script>alert(1)</script>\n[link](https://example.invalid)\n@include';
  const source = { path: 'tools/review/SKILL.md', name: 'review', content, hash: 'b'.repeat(64), bytes: 80 };
  const preview = renderToStaticMarkup(createElement(NativeSourcePreview, { source }));
  assert.match(preview, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(preview, /\[link\]\(https:\/\/example.invalid\)/);
  assert.doesNotMatch(preview, /<script|<a /);
  assert.match(preview, /SHA-256：/); assert.match(preview, /80 字节/);
  const instructionMarkup = renderToStaticMarkup(createElement(NativeInstructionSources, { result: { targetPath: 'src', digest: 'd'.repeat(64), sources: [{ ...source, path: 'CLAUDE.md', scope: '.' }, { ...source, path: 'AGENTS.md', scope: '.' }, { ...source, path: 'src/AGENTS.md', scope: 'src' }] } }));
  assert.ok(instructionMarkup.indexOf('<summary>CLAUDE.md') < instructionMarkup.indexOf('<summary>AGENTS.md'));
  assert.ok(instructionMarkup.indexOf('<summary>AGENTS.md') < instructionMarkup.indexOf('<summary>src/AGENTS.md'));
  assert.match(instructionMarkup, /深层优先，同层 AGENTS.md 优先于 CLAUDE.md。用户指令优先/);
  const empty = renderToStaticMarkup(createElement(NativeInstructionSources, { result: { targetPath: '.', digest: 'd'.repeat(64), sources: [] } }));
  assert.match(empty, /未发现适用的 AGENTS.md 或 CLAUDE.md/);
});

test('the 16-item limit blocks new choices while allowing removals; a session lock blocks all choices', () => {
  const selected = Array.from({ length: 16 }, (_, index) => `.agents/skills/item-${index}/SKILL.md`);
  const markup = renderChoices(selected);
  assert.equal((markup.match(/disabled=""/g) ?? []).length, 2);
  assert.equal((markup.match(/checked=""/g) ?? []).length, 16);
  assert.deepEqual(toggleProjectSkill(selected, agentPath), selected);
  assert.deepEqual(toggleProjectSkill(selected, selected[3]), selected.filter((_, index) => index !== 3));
  const locked = renderChoices([agentPath], result, true);
  assert.equal((locked.match(/disabled=""/g) ?? []).length, 2);
});

function session(providerId = 'native'): Session {
  return { id: 'one', projectId: 'project', title: 'Project Skills', kind: 'agent', cwd: '/project',
    execution: { providerId, mode: 'structured' }, engineConfig: { schemaVersion: 1, options: { projectSkills: [agentPath] } },
    started: false, status: 'idle', archived: false, createdAt: '', updatedAt: '' };
}
function descriptor(providerId = 'native'): ExecutionDescriptor {
  return { providerId, mode: 'structured', displayName: 'Native',
    capabilities: { available: true, structured: true, terminal: false, approvals: true, resume: true, fork: false, commands: false, contextUsage: true, liveConfig: true, attachments: false },
    configuration: { schemaVersion: 1, defaults: { schemaVersion: 1, options: {} }, fields: [] } };
}
const renderConfig = (value = session(), executor = descriptor()) => renderToStaticMarkup(createElement(SessionConfig, { session: value, descriptor: executor, onError: fail }));

test('project Skills are scoped to native structured session settings and use the existing save and task lock', () => {
  const idle = renderConfig();
  assert.match(idle, /aria-label="项目 Skills"/);
  assert.match(idle, /保存配置/);
  assert.doesNotMatch(idle, /type="checkbox"[^>]*disabled=""/);
  assert.doesNotMatch(idle, /<button[^>]*class="secondary compact full"[^>]*disabled=""/);
  for (const provider of ['claude', 'shell', 'future-provider']) {
    assert.doesNotMatch(renderConfig(session(provider), descriptor(provider)), /aria-label="项目 Skills"/);
  }
  const terminal = session(); terminal.execution.mode = 'terminal';
  assert.doesNotMatch(renderConfig(terminal), /aria-label="项目 Skills"/);
  const active = session(); active.status = 'running'; active.taskState = 'thinking';
  const locks = [renderConfig(active), renderConfig(session(), { ...descriptor(), maintenance: true })];
  for (const locked of locks) {
    assert.match(locked, /disabled=""[^>]*>读取项目 Skills<\/button>/);
    assert.match(locked, /type="checkbox"[^>]*disabled=""/);
    assert.match(locked, /disabled=""[^>]*>[\s\S]*?保存配置/);
  }
});

test('unsupported persisted Skill configuration is preserved instead of coercing it to an empty list', () => {
  const malformed = session(); malformed.engineConfig.options.projectSkills = { future: ['keep'] };
  assert.match(renderConfig(malformed), /当前项目 Skills 配置无法编辑，原始值已保留/);
  assert.doesNotMatch(renderConfig(malformed), /aria-label="项目 Skills"/);
  assert.deepEqual(malformed.engineConfig.options.projectSkills, { future: ['keep'] });
});
