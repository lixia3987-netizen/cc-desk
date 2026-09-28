import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { automaticSessionTitlePatch, initialSessionTitle, normalizeGeneratedSessionTitle } from '../src/shared/session-title';
import { sessionInputSchema } from '../src/shared/schema';
import { StateStore } from '../src/main/store';
import type { Session } from '../src/shared/types';

test('only blank names on new Claude conversations opt into automatic naming', () => {
  assert.deepEqual(initialSessionTitle({ title: '  ', kind: 'agent' }), { title: '新的开发会话', titleSource: 'default' });
  assert.deepEqual(initialSessionTitle({ title: '  登录修复  ', kind: 'agent' }), { title: '登录修复', titleSource: 'manual' });
  assert.equal(initialSessionTitle({ title: '新的开发会话', kind: 'agent' }).titleSource, 'manual');
  for (const input of [
    { title: '', kind: 'shell' as const },
    { title: '', kind: 'agent' as const, conversationId: randomUUID() },
    { title: '', kind: 'agent' as const, fork: true }
  ]) assert.equal(initialSessionTitle(input).titleSource, 'manual');
  assert.equal(initialSessionTitle({ title: '', kind: 'shell' }).title, '项目终端');
  const input = { projectId: randomUUID(), title: '  ', kind: 'agent', model: '', effort: 'default', isolated: false };
  assert.equal(sessionInputSchema.parse(input).title, '');
  assert.equal(sessionInputSchema.safeParse({ ...input, title: 'a'.repeat(121) }).success, false);
});

test('generated labels are normalized without extracting titles from user prose', () => {
  assert.equal(normalizeGeneratedSessionTitle('  标题：“登录校验修复”  '), '登录校验修复');
  assert.equal(normalizeGeneratedSessionTitle('\u001b[31m修复\u001b[0m登录\u202e\u0000校验'), '修复登录校验');
  for (const output of ['', ' \n\t', '这是标题\n另有说明', '```text\n登录修复\n```', '---']) {
    assert.equal(normalizeGeneratedSessionTitle(output), undefined, output);
  }
});

test('automatic labels are short, single-line and retain complete Unicode graphemes', () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const prompt = '修复👨‍👩‍👧‍👦的多语言输入体验'.repeat(20);
  const title = normalizeGeneratedSessionTitle(prompt)!;
  assert.ok(title.endsWith('…'));
  assert.ok(title.length <= 120);
  assert.ok([...segmenter.segment(title)].length <= 48);
  assert.ok(!/[\r\n]/.test(title));
  assert.ok(prompt.startsWith(title.slice(0, -1)));
  assert.equal(normalizeGeneratedSessionTitle('Cafe\u0301 输入问题'), 'Café 输入问题');
  assert.equal(normalizeGeneratedSessionTitle('Fix authentication refresh handling and preserve the previous user settings while adding validation tests'), 'Fix authentication refresh handling and…');
});

test('auto naming never changes manual, legacy, shell, imported, forked or already named sessions', () => {
  for (const session of [
    { kind: 'agent' as const, execution: {providerId:'claude',mode:'structured' as const} },
    { kind: 'agent' as const, titleSource: 'manual' as const, execution: {providerId:'claude',mode:'structured' as const} },
    { kind: 'agent' as const, titleSource: 'auto' as const, execution: {providerId:'claude',mode:'structured' as const} },
    { kind: 'shell' as const, titleSource: 'default' as const, execution: {providerId:'shell',mode:'terminal' as const} },
    { kind: 'agent' as const, titleSource: 'default' as const, execution: {providerId:'claude',mode:'structured' as const,imported:true} },
    { kind: 'agent' as const, titleSource: 'default' as const, execution: {providerId:'claude',mode:'structured' as const,forkFrom:randomUUID()} }
  ]) assert.equal(automaticSessionTitlePatch(session, '后续请求不应覆盖名称'), undefined);
});

test('title provenance and generated labels survive persistence without renaming old default-looking names', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desk-title-'));
  try {
    const store = new StateStore(directory);
    const timestamp = new Date().toISOString();
    const legacy: Session = { execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() }, id: randomUUID(), projectId: randomUUID(),  cwd: directory, title: '新的开发会话',
      kind: 'agent',  started: false, model: '', effort: 'default', permissionMode: 'default',
      status: 'idle', archived: false, createdAt: timestamp, updatedAt: timestamp };
    const pending: Session = { ...legacy, execution: { ...legacy.execution, conversationId: randomUUID() }, id: randomUUID(),  titleSource: 'default' };
    store.change(state => state.sessions.push(legacy, pending));
    const restored = new StateStore(directory);
    assert.equal(restored.state.sessions[0].titleSource, undefined);
    assert.equal(automaticSessionTitlePatch(restored.state.sessions[0], '新的请求'), undefined);
    restored.change(state => Object.assign(state.sessions[1], automaticSessionTitlePatch(state.sessions[1], '修复会话状态与命名')));
    const named = new StateStore(directory).state.sessions[1];
    assert.equal(named.title, '修复会话状态与命名');
    assert.equal(named.titleSource, 'auto');
    assert.equal(automaticSessionTitlePatch(named, '第二轮不覆盖标题'), undefined);
    restored.change(state => { state.sessions[1].title = '我的排查记录'; state.sessions[1].titleSource = 'manual'; });
    assert.equal(new StateStore(directory).state.sessions[1].titleSource, 'manual');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
