import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NativeTaskEvidence, NativeTaskSnapshot, NativeTaskWorkspace } from '@cc-desk/contracts/native-task';
import { toNativeTaskView } from '../src/shared/native-task';
import { NativeTaskPanel, nativeTaskCanApprove, nativeTaskEvidenceState } from '../src/renderer/NativeTaskPanel';

const at = '2026-09-28T12:00:00.000Z';
const identity = { sessionId: 'session', conversationId: 'conversation', runId: 'run', requestId: 'request', workerGeneration: 1 };
const workspace = (): NativeTaskWorkspace => ({ fingerprint: 'current', complete: true, rootFingerprint: 'root', files: [], scope: ['project source; generated and sensitive files excluded'], issues: [], capturedAt: at });
function task(): NativeTaskSnapshot {
  return {
    schemaVersion: 1, taskId: 'task-1', identity, revision: 8, planRevision: 2, acceptanceRevision: 1,
    execution: 'ended', runOutcome: 'completed', verification: 'unverified', goal: '修复任务状态刷新',
    steps: [{ id: 'inspect', title: '定位状态来源', dependsOn: [], status: 'implemented' }, { id: 'fix', title: '修复重同步', dependsOn: ['inspect'], status: 'implemented' }],
    criteria: [{ id: 'race', description: '旧会话的迟到响应不覆盖当前任务', stepIds: ['fix'], kind: 'command' }],
    evidence: [], workspace: { baseline: workspace(), current: workspace(), changes: { complete: true, added: ['src/new.ts'], modified: ['src/state.ts'], removed: [], attribution: 'observed_since_task_start', truncated: false } },
    history: [{ revision: 1, mutationId: 'mutation', kind: 'plan', runId: 'run', at, summary: '创建计划' }], createdAt: at, updatedAt: at,
  };
}
function evidence(patch: Partial<NativeTaskEvidence> = {}): NativeTaskEvidence {
  return { id: 'evidence', identity, stepIds: ['fix'], criterionIds: ['race'], source: 'manual', status: 'passed',
    planRevision: 2, acceptanceRevision: 1, workspaceFingerprint: 'current', workspaceComplete: true,
    reason: '审阅改动并确认竞态测试覆盖迟到响应', createdAt: at, ...patch };
}
function locationEvidence(patch: Partial<NativeTaskEvidence> = {}): NativeTaskEvidence {
  return evidence({ id: 'location-1', source: 'location', status: 'unverified', reason: undefined, toolCallId: 'location-call-1',
    location: { path: 'src/state.ts', startLine: 7, endLine: 9, fileHash: 'a'.repeat(64), fileBytes: 160,
      excerpt: 'const current = 1;\r\n\r\nreturn current;\r\n', excerptHash: 'b'.repeat(64) }, ...patch });
}
const fail = () => { throw new Error('Rendering must not start a task or perform review'); };
const render = (state: NativeTaskSnapshot | null, props: Partial<Parameters<typeof NativeTaskPanel>[0]> = {}) => renderToStaticMarkup(createElement(NativeTaskPanel, {
  task: state ? toNativeTaskView(state) : null, onContinue: fail, onRefresh: fail, onReview: async () => fail(), ...props,
}));

test('task presentation separates operational finish, model implementation declarations, and unverified acceptance', () => {
  const markup = render(task());
  assert.match(markup, /运行：本轮正常结束/);
  assert.match(markup, /实现声明：2 \/ 2 步/);
  assert.match(markup, /验证：未验证/);
  assert.match(markup, /模型声明已实现/);
  assert.match(markup, /依赖：定位状态来源/);
  assert.match(markup, /旧会话的迟到响应不覆盖当前任务/);
  assert.match(markup, /未记录验证证据/);
  assert.match(markup, /任务验收条件尚未满足/);
  assert.match(markup, /继续此任务/);
  assert.match(markup, /只关联下一条指令；发送后才运行/);
  assert.doesNotMatch(markup, /验证：验收通过/);
  assert.equal(nativeTaskCanApprove(toNativeTaskView(task())), false);
  assert.match(markup, /maxLength="2000"/);
});

test('unknown task snapshot visibly loses current success and disables mutation controls', () => {
  const state = task(); state.verification = 'passed'; state.evidence = [evidence()]; state.review = { status: 'approved', reason: '已核查', at };
  const markup = render(state, { loadError: '读取失败' });
  assert.match(markup, /任务状态未知：读取失败/);
  assert.match(markup, /仅为上次保存的快照/);
  assert.match(markup, /运行：当前状态未知/);
  assert.match(markup, /验证：当前状态未知/);
  assert.match(markup, /当前有效性待核查/);
  assert.doesNotMatch(markup, /data-evidence-status="passed"|验证：验收通过/);
  assert.match(markup, /disabled=""[^>]*>继续此任务/);
});

test('command receipts show exact argv, exit code, provenance and truncation without claiming acceptance', () => {
  const state = task(); state.evidence = [evidence({ source: 'command', status: 'unverified', reason: undefined,
    command: { executable: 'node', argv: ['--test', 'tests/race test.ts'], cwd: '/project' }, toolCallId: 'tool-7', exitCode: 0,
    output: '<script>fake completion</script>', outputDigest: 'digest', truncated: true })];
  const markup = render(state);
  assert.match(markup, /宿主命令回执/);
  assert.match(markup, /退出码：0/);
  assert.match(markup, /tool-7/);
  assert.match(markup, /tests\/race test.ts/);
  assert.match(markup, /工作目录：<code>\/project/);
  assert.match(markup, /命令输出已截断/);
  assert.match(markup, /退出码为 0 不代表任务验收通过/);
  assert.match(markup, /来源回合：<code>run/);
  assert.match(markup, /&lt;script&gt;fake completion&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>|data-evidence-status="passed"/);
  assert.equal(nativeTaskCanApprove(toNativeTaskView(state)), false);
  assert.equal(nativeTaskEvidenceState(toNativeTaskView(state), evidence({ source: 'command', status: 'passed', exitCode: 0 })), 'unverified');
  assert.equal(nativeTaskEvidenceState(toNativeTaskView(state), evidence({ source: 'command', status: 'unverified', exitCode: 1 })), 'failed');
});

test('manual evidence is version-bound and incomplete or stale evidence cannot permit approval', () => {
  const state = task(); state.evidence = [evidence()];
  assert.equal(nativeTaskCanApprove(toNativeTaskView(state)), true);
  for (const patch of [{ stale: true }, { planRevision: 1 }, { acceptanceRevision: 0 }, { workspaceFingerprint: 'earlier' }]) {
    state.evidence = [evidence(patch)];
    assert.equal(nativeTaskEvidenceState(toNativeTaskView(state), state.evidence[0]), 'stale');
    assert.equal(nativeTaskCanApprove(toNativeTaskView(state)), false);
    const markup = render(state);
    assert.match(markup, /data-evidence-status="stale"/);
    assert.match(markup, /此证据不计入当前验收/);
    assert.doesNotMatch(markup, /data-evidence-status="passed"/);
  }
  state.evidence = [evidence({ workspaceComplete: false })];
  assert.equal(nativeTaskEvidenceState(toNativeTaskView(state), state.evidence[0]), 'unverified');
  assert.equal(nativeTaskCanApprove(toNativeTaskView(state)), false);
  state.evidence = [evidence()]; state.workspace!.current.complete = false; assert.equal(nativeTaskCanApprove(toNativeTaskView(state)), false);
  assert.match(render(state), /现场版本尚未完整记录/);
});

test('latest failed/manual not-applicable condition, pending implementation and active execution gate final approval', () => {
  const state = task(); state.evidence = [evidence(), evidence({ id: 'later', status: 'failed', reason: '发现遗漏的迟到回调' })];
  assert.equal(nativeTaskCanApprove(toNativeTaskView(state)), false);
  state.evidence.push(evidence({ id: 'na', status: 'not_applicable', reason: '此任务变体无网络请求，改以同步状态校验' }));
  assert.equal(nativeTaskCanApprove(toNativeTaskView(state)), true);
  state.steps[1].status = 'blocked'; state.steps[1].blockedReason = '缺少复现场景';
  assert.equal(nativeTaskCanApprove(toNativeTaskView(state)), false);
  assert.match(render(state), /阻塞原因：缺少复现场景/);
  state.steps[1].status = 'implemented'; state.execution = 'active';
  assert.equal(nativeTaskCanApprove(toNativeTaskView(state)), false);
  assert.match(render(state), /本轮仍在运行/);
  assert.match(render(state), /disabled=""[^>]*>继续此任务/);
  state.execution = 'ended'; state.criteria = []; assert.equal(nativeTaskCanApprove(toNativeTaskView(state)), false);
  assert.match(render(state), /未记录验收条件/);
});

test('observed change summary exposes incomplete scope and does not imply ownership or rollback', () => {
  const state = task(); state.workspace!.changes.truncated = true; state.workspace!.current.issues = ['某目录无法读取'];
  const markup = render(state);
  assert.match(markup, /任务期间观察到的文件变化/);
  assert.match(markup, /可能包含外部修改/);
  assert.match(markup, /完整性仅针对声明的扫描范围/);
  assert.match(markup, /src\/new.ts/); assert.match(markup, /src\/state.ts/);
  assert.match(markup, /变更摘要不完整或已截断/);
  assert.match(markup, /某目录无法读取/);
  assert.match(markup, /计划与状态修订记录（1）/);
  assert.match(markup, /修订 1 · 创建计划/);
});

test('simple questions have no mandatory plan panel and initial loading/error remain explicit', () => {
  assert.equal(render(null), '');
  assert.match(render(null, { loading: true }), /正在读取已保存的任务/);
  assert.match(render(null, { loadError: '状态文件损坏' }), /任务状态未知/);
  assert.doesNotMatch(render(null, { loadError: '状态文件损坏' }), /继续此任务|记录人工核验/);
});


test('task IPC view omits per-file inventories, preserves counts and evidence, and cannot mutate the durable snapshot', () => {
  const state = task(); state.workspace!.baseline.files = [{ path: 'private-inventory-path.ts', hash: 'private-file-hash', bytes: 1, mode: 420 }];
  state.workspace!.current.files = [...state.workspace!.baseline.files, { path: 'other-inventory-path.ts', hash: 'other-file-hash', bytes: 2, mode: 420 }];
  state.evidence = [evidence()];
  const view = toNativeTaskView(state);
  assert.equal(view.workspace!.baseline.fileCount, 1); assert.equal(view.workspace!.current.fileCount, 2);
  assert.equal('files' in view.workspace!.baseline, false); assert.equal('files' in view.workspace!.current, false);
  assert.doesNotMatch(JSON.stringify(view), /private-inventory-path|private-file-hash|other-inventory-path|other-file-hash/);
  assert.deepEqual(view.evidence, state.evidence);
  view.workspace!.current.scope.push('changed in UI'); view.evidence[0].reason = 'changed in UI';
  assert.equal(state.workspace!.current.scope.includes('changed in UI'), false);
  assert.notEqual(state.evidence[0].reason, 'changed in UI');
  assert.match(render(state), /记录文件：起始 1 项 · 当前 2 项/);
});

test('manual acceptance remains separate from later command receipts and old tasks are clearly identified', () => {
  const state = task(); state.evidence = [evidence(), evidence({ id: 'later-command', source: 'command', status: 'unverified', exitCode: 0 })];
  assert.equal(nativeTaskCanApprove(toNativeTaskView(state)), true, 'a command receipt does not overwrite the latest human condition review');
  state.evidence.push(evidence({ id: 'later-manual', status: 'failed', reason: '人工发现新问题' }));
  assert.equal(nativeTaskCanApprove(toNativeTaskView(state)), false);
  const markup = render(state, { historical: true });
  assert.match(markup, /较早任务，未关联当前回合/);
  assert.match(markup, /任务最近运行：本轮正常结束/);
  assert.match(markup, /继续此任务/);
});

test('code locations present a saved, unverified excerpt and model-declared associations without changing acceptance', () => {
  const state = task(); state.evidence = [locationEvidence()];
  const markup = render(state);
  assert.match(markup, /代码位置记录/);
  assert.match(markup, /src\/state.ts:7–9/);
  assert.match(markup, /记录时版本的只读片段，并非当前文件内容/);
  assert.match(markup, /步骤和条件关联由模型声明，供人工核查，不自动验收/);
  assert.match(markup, /文件 SHA-256：<code>a{64}/);
  assert.match(markup, /文件字节数：160/);
  assert.match(markup, /片段 SHA-256：<code>b{64}/);
  assert.match(markup, /data-evidence-status="unverified"/);
  assert.doesNotMatch(markup, /<span>人工核验<\/span>|data-evidence-status="passed"/);
  assert.equal(nativeTaskCanApprove(toNativeTaskView(state)), false);
  assert.equal(nativeTaskEvidenceState(toNativeTaskView(state), locationEvidence({ status: 'passed', reason: '模型声称已确认' })), 'unverified');
  state.evidence.unshift(evidence());
  assert.equal(nativeTaskCanApprove(toNativeTaskView(state)), true, 'a later location receipt does not supersede explicit human review');
});

test('linked steps and criteria use matching internal evidence anchors with task identity and safe path/excerpt text', () => {
  const state = task(); state.taskId = 'task:" /😀';
  const receipt = locationEvidence(); receipt.id = 'record:" /😀';
  receipt.location!.path = 'javascript:alert(1)/<img onerror="evil">.ts';
  receipt.location!.excerpt = '</code><script>alert("unsafe")</script>\n'; receipt.location!.startLine = receipt.location!.endLine = 1;
  state.evidence = [receipt];
  const markup = render(state);
  const anchor = markup.match(/<details id="([^"]+)" tabindex="-1" class="native-task-evidence"/)?.[1];
  assert.ok(anchor);
  assert.match(anchor, /^native-task-evidence-[0-9a-f]+-[0-9a-f]+$/);
  assert.equal(markup.split(`href="#${anchor}"`).length - 1, 2, 'both the matching step and criterion point at this receipt');
  const stepMarkup = markup.match(/<ol class="native-task-steps">([\s\S]*?)<\/ol>/)![1];
  const stepItems = stepMarkup.split('</li>');
  assert.doesNotMatch(stepItems[0], /href=/, 'unrelated steps have no location link');
  assert.match(stepItems[1], /href="#native-task-evidence-/);
  assert.match(markup, /javascript:alert\(1\)\/&lt;img onerror=&quot;evil&quot;&gt;\.ts/);
  assert.match(markup, /&lt;\/code&gt;&lt;script&gt;alert\(&quot;unsafe&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>|<img|href="javascript:|href="file:|onerror="/);
  state.taskId += '-other';
  const otherAnchor = render(state).match(/<details id="([^"]+)" tabindex="-1" class="native-task-evidence"/)?.[1];
  assert.notEqual(otherAnchor, anchor, 'the same receipt identifier in another task does not collide');
});

test('code excerpt line numbering preserves CRLF and real blank lines without a virtual trailing line', () => {
  const state = task(); state.evidence = [locationEvidence()];
  const markup = render(state);
  assert.deepEqual([...markup.matchAll(/class="native-task-line-number" aria-hidden="true">(\d+)/g)].map(match => Number(match[1])), [7, 8, 9]);
  assert.deepEqual([...markup.matchAll(/class="native-task-line-text">([\s\S]*?)<\/span>/g)].map(match => match[1]), ['const current = 1;\r\n', '\r\n', 'return current;\r\n']);
  state.evidence[0].location!.excerpt = 'last line without newline';
  state.evidence[0].location!.startLine = state.evidence[0].location!.endLine = 80;
  const finalLine = render(state);
  assert.match(finalLine, /aria-hidden="true">80<\/span><span class="native-task-line-text">last line without newline<\/span>/);
  assert.equal((finalLine.match(/class="native-task-line-number"/g) || []).length, 1);
});

test('stale and unknown code locations keep old excerpts available while discarding current success presentation', () => {
  const state = task(); state.evidence = [locationEvidence({ stale: true })];
  const historical = render(state);
  assert.match(historical, /data-evidence-status="stale"/);
  assert.match(historical, /历史位置记录/);
  assert.match(historical, /不能确认当前文件仍有相同内容/);
  assert.match(historical, /const current = 1;/);
  const unknown = render(state, { loadError: '任务记录不可读' });
  assert.match(unknown, /data-evidence-status="unverified"/);
  assert.match(unknown, /当前状态未知：保留的片段/);
  assert.match(unknown, /const current = 1;/);
  assert.doesNotMatch(historical + unknown, /data-evidence-status="passed"|class="native-task-state passed"/);
  state.evidence = [locationEvidence({ location: undefined })];
  assert.match(render(state), /此记录缺少代码位置内容/);
});

test('old evidence without a location remains usable and location snapshots are detached from the IPC view', () => {
  const state = task(); state.evidence = [evidence(), evidence({ id: 'old-command', source: 'command', status: 'unverified', reason: undefined })];
  const oldMarkup = render(state);
  assert.match(oldMarkup, /<span>人工核验<\/span>/);
  assert.match(oldMarkup, /宿主命令回执/);
  assert.doesNotMatch(oldMarkup, /代码位置记录|native-task-location-excerpt/);
  state.evidence.push(locationEvidence());
  const view = toNativeTaskView(state);
  assert.deepEqual(view.evidence[2].location, state.evidence[2].location);
  view.evidence[2].location!.excerpt = 'renderer modification';
  assert.equal(state.evidence[2].location!.excerpt, 'const current = 1;\r\n\r\nreturn current;\r\n');
});
