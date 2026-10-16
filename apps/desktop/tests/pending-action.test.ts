import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingAction, type PendingActionState } from '../src/renderer/pending-action';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test('a pending action publishes feedback and locks before painting or dispatching its IPC', async () => {
  const action = new PendingAction(), paint = gate(), ipc = gate(), sync = gate(), states: Array<PendingActionState | undefined> = [];
  let calls = 0;
  const pending = action.run({ key: 'session-one', label: '正在恢复会话…' }, async () => { calls++; await ipc.promise; await sync.promise; }, value => states.push(value), () => paint.promise);
  assert.equal(states.length, 1); assert.deepEqual(states[0], { key: 'session-one', label: '正在恢复会话…' }); assert.equal(calls, 0);
  assert.equal(await action.run({ key: 'session-one', label: '重复恢复' }, async () => { calls++; }, value => states.push(value)), false);
  paint.release(); await Promise.resolve(); assert.equal(calls, 1);
  ipc.release(); await Promise.resolve(); assert.ok(action.state, 'accepted operations stay locked while authoritative state is synchronizing');
  sync.release(); assert.equal(await pending, true); assert.equal(action.state, undefined); assert.equal(states.at(-1), undefined);
});

test('a failed action releases its gate, surfaces the error and can be retried', async () => {
  const action = new PendingAction(), states: Array<PendingActionState | undefined> = [];
  await assert.rejects(action.run({ key: 'workflow-one', label: '正在重试…' }, async () => { throw new Error('IPC unavailable'); }, value => states.push(value), async () => {}), /IPC unavailable/);
  assert.equal(action.state, undefined); assert.equal(states.at(-1), undefined);
  let accepted = 0;
  assert.equal(await action.run({ key: 'workflow-one', label: '再次重试…' }, async () => { accepted++; }, value => states.push(value), async () => {}), true);
  assert.equal(accepted, 1);
});

test('the pending target remains bound when selection changes before the IPC finishes', async () => {
  const action = new PendingAction(), ipc = gate(); let selected = 'session-one', visible: PendingActionState | undefined;
  const pending = action.run({ key: selected, label: '正在关闭终端…' }, () => ipc.promise, value => { visible = value; }, async () => {});
  selected = 'session-two';
  assert.equal(visible?.key === selected, false, 'another session must not inherit the previous session action label');
  assert.equal(action.state?.key, 'session-one');
  ipc.release(); await pending; assert.equal(visible, undefined);
});

test('an interrupt acknowledgement alone cannot reopen a busy or unknown terminal task', async () => {
  const { terminalInterruptSettled } = await import('../src/renderer/pending-action');
  assert.equal(terminalInterruptSettled({ status: 'running', taskState: 'thinking' }), false);
  assert.equal(terminalInterruptSettled({ status: 'running', taskState: 'tool_running' }), false);
  assert.equal(terminalInterruptSettled({ status: 'running' }), false);
  assert.equal(terminalInterruptSettled({ status: 'stopping', taskState: 'interrupted' }), false);
  assert.equal(terminalInterruptSettled({ status: 'running', taskState: 'interrupted' }), true);
  assert.equal(terminalInterruptSettled({ status: 'stopped', taskState: 'thinking' }), true);
  assert.equal(terminalInterruptSettled(undefined), true);
});
