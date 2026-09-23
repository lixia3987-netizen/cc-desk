import assert from 'node:assert/strict';
import test from 'node:test';
import { composerKeyAction, insertComposerNewline, terminalPromptPacket } from '../src/renderer/composer-keyboard';
import { hasActiveSubtasks, isSessionBusy } from '../src/shared/session-activity';
import type { Session } from '../src/shared/types';

test('Enter sends once, modifier Enter inserts a newline, and IME confirmation never sends', () => {
  assert.equal(composerKeyAction({ key: 'Enter' }), 'send');
  assert.equal(composerKeyAction({ key: 'Enter', repeat: true }), 'consume');
  for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey']) {
    assert.equal(composerKeyAction({ key: 'Enter', [modifier]: true }), 'newline');
  }
  assert.equal(composerKeyAction({ key: 'Enter', isComposing: true }), undefined);
  assert.equal(composerKeyAction({ key: 'Enter' }, true), undefined);
  assert.equal(composerKeyAction({ key: 'Enter', keyCode: 229 }), undefined);
  assert.equal(composerKeyAction({ key: 'Enter', ctrlKey: true, isComposing: true }), undefined);
  assert.equal(composerKeyAction({ key: 'Enter', altKey: true }), undefined);
  assert.equal(composerKeyAction({ key: 'a' }), undefined);
  assert.deepEqual(insertComposerNewline('前缀选中的文本后缀', 2, 7), { value: '前缀\n后缀', caret: 3 });
  assert.deepEqual(insertComposerNewline('首行尾', 2, 2), { value: '首行\n尾', caret: 3 });
});

test('native prompt keeps multiline content in one bracketed paste before sending a single Enter', () => {
  assert.equal(terminalPromptPacket('第一行\r\n\t第二行\n第三行\r第四行'), '\x1b[200~第一行\r\t第二行\r第三行\r第四行\x1b[201~\r');
  for (const text of ['前缀\x1b[201~\rmalicious', '中断\x03', '\0', '\x9b201~']) {
    assert.throws(() => terminalPromptPacket(text), /终端控制字符/);
  }
});

test('completed resident CLI is idle while active children and unknown native activity remain busy', () => {
  const session: Pick<Session, 'kind' | 'adapter' | 'status' | 'taskState' | 'terminalSync' | 'subtasks'> = {
    kind: 'claude', adapter: 'structured', status: 'running', taskState: 'completed'
  };
  assert.equal(isSessionBusy(session), false);
  assert.equal(isSessionBusy({ ...session, taskState: 'thinking' }), true);
  assert.equal(isSessionBusy({ ...session, taskState: 'waiting_approval' }), true);
  assert.equal(isSessionBusy({ ...session, status: 'stopping' }), true);
  assert.equal(isSessionBusy({ ...session, adapter: 'terminal', terminalSync: 'synced' }), false);
  assert.equal(isSessionBusy({ ...session, adapter: 'terminal', terminalSync: 'unsupported' }), true);
  assert.equal(isSessionBusy({ ...session, kind: 'shell', adapter: 'terminal' }), true);
  session.subtasks = { turnId: 't1', tasks: [{ id: 'child1', turnId: 't1', source: 'stream', kind: 'agent', description: '仍在执行的子任务', status: 'running', startedAt: '', updatedAt: '' }] };
  assert.equal(hasActiveSubtasks(session), true);
  assert.equal(isSessionBusy(session), true);
  session.subtasks.tasks[0].status = 'completed';
  assert.equal(isSessionBusy(session), false);
});
