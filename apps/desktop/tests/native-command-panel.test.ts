import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NativeCommandView } from '../src/shared/chat';
import { NativeCommandPanel } from '../src/renderer/NativeCommandPanel';

const command = (patch: Partial<NativeCommandView> = {}): NativeCommandView => ({
  commandId: 'command-1', taskId: 'task-1', runId: 'run-1', toolCallId: 'start-1',
  command: { executable: 'node', argv: ['-e', '<script>model says passed</script>'], cwd: '项目 空格' },
  status: 'running', preparedAt: '2026-09-28T16:00:00.000Z', runningAt: '2026-09-28T16:00:01.000Z', timeoutMs: 10000, maxOutputBytes: 65536,
  ...patch,
});
const result: NonNullable<NativeCommandView['result']> = {
  exitCode: 0, signal: null, stdout: '<img src=x onerror=alert(1)>\n验收通过', stderr: 'stderr independently retained',
  outputBytes: 80000, truncated: true, cancelled: true, timedOut: false, cleanup: 'released',
};
const render = (items: NativeCommandView[], props: Partial<Parameters<typeof NativeCommandPanel>[0]> = {}) => renderToStaticMarkup(createElement(NativeCommandPanel, {
  commands: { items, omitted: 0 }, currentRunId: 'run-1', ...props,
}));

test('long-command presentation separates prepared/running state and historical identity from task acceptance', () => {
  const html = render([command(), command({ commandId: 'earlier', runId: 'old-run', status: 'prepared', runningAt: undefined })]);
  assert.match(html, /当前回合/); assert.match(html, /历史回合/);
  assert.match(html, /data-command-status="running"/); assert.match(html, /data-command-status="prepared"/);
  assert.match(html, /尚未收到宿主确认进程已启动/);
  assert.match(html, /任务：<code>task-1/); assert.match(html, /回合：<code>old-run/); assert.match(html, /启动工具调用：<code>start-1/);
  assert.match(html, /不代表任务验收通过/); assert.match(html, /停止/);
  assert.match(html, /10000 毫秒/); assert.match(html, /65536 字节/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|<button|<iframe/);
});

test('terminal host receipts preserve bounded stdout/stderr as text and expose exit/cancel/cleanup/truncation', () => {
  const html = render([command({ status: 'finished', result, finishedAt: '2026-09-28T16:00:05.000Z' })]);
  assert.match(html, /已结束/); assert.match(html, /退出码：0/); assert.match(html, /取消：是/); assert.match(html, /超时：否/);
  assert.match(html, /清理：已确认/); assert.match(html, /输出已截断，日志不完整/);
  assert.match(html, /aria-label="命令标准输出"/); assert.match(html, /aria-label="命令标准错误"/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(html, /<img|data-command-status="passed"/);
});

test('missing terminal, failed cleanup, timeout and failed snapshot stay explicitly unknown', () => {
  const html = render([command({ status: 'unknown', missingTerminal: true }), command({ commandId: 'unclean', status: 'unknown', result: { ...result, cleanup: 'cleanup_failed', timedOut: true, error: 'cleanup timeout' } })]);
  assert.match(html, /缺少已保存的终局回执/); assert.match(html, /不会根据旧 PID 接管或自动重启/);
  assert.match(html, /清理：未确认/); assert.match(html, /超时：是/); assert.match(html, /不能证明进程已经停止/);
  const stale = render([command({ status: 'finished', result })], { loadError: '快照读取失败' });
  assert.match(stale, /data-command-status="unknown"/); assert.doesNotMatch(stale, /data-command-status="finished"/);
  assert.match(stale, /下方为上次保存的快照/); assert.match(stale, /以下为上次保存的命令结果/);
});

test('empty command panels do not appear and bounded history declares omitted records', () => {
  assert.equal(render([]), '');
  assert.match(render([command()], { commands: { items: [command()], omitted: 13 } }), /另有 13 条历史命令保留在执行记录中/);
});
