import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Attachments, MAX_FILE } from '../src/main/attachments';
import { DraftAttachments, MAX_DRAFT_ATTACHMENT_SELECTIONS } from '../src/main/draft-attachments';

const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-draft-attachments-'));
  const directory = path.join(root, 'data'), manager = new Attachments(directory);
  return { root, directory, manager, drafts: new DraftAttachments(manager),
    file: async (name: string, contents = 'approved contents') => {
      const file = path.join(root, name); await fs.writeFile(file, contents); return file;
    },
    dispose: () => fs.rm(root, { recursive: true, force: true }),
  };
};

test('pre-session selection only reads metadata; staging creates owned copies for the chosen session', async () => {
  const f = await fixture();
  try {
    const source = await f.file('参考文本.txt');
    const selected = await f.drafts.inspect([source]);
    assert.match(selected[0].selectionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(selected.map(({ selectionId: _selectionId, ...file }) => file), [{ path: source, name: '参考文本.txt', bytes: 17 }]);
    await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
    await assert.rejects(f.manager.validate('session-a', [source]), /不属于当前会话/);
    let checks = 0;
    const [copy] = await f.drafts.stage('session-a', selected, () => { checks++; });
    assert.equal(checks, 2);
    assert.notEqual(copy.path, source);
    assert.equal(copy.name, '参考文本.txt');
    assert.deepEqual(await f.manager.validate('session-a', [copy.path]), [copy.path]);
    await assert.rejects(f.manager.validate('session-b', [copy.path]), /不属于当前会话/);
    await fs.writeFile(source, 'later edit');
    assert.equal(await fs.readFile(copy.path, 'utf8'), 'approved contents');
  } finally { await f.dispose(); }
});

test('draft attachment selection rejects directories, unsupported types, invalid paths and all size limits', async () => {
  const f = await fixture();
  try {
    const source = await f.file('valid.txt'), unsupported = await f.file('program.exe');
    for (const file of ['relative.txt', source + '\n', source + '\0']) {
      await assert.rejects(f.drafts.inspect([file]), /有效的本机绝对路径/);
    }
    await assert.rejects(f.drafts.inspect([f.root]), /暂不支持添加文件夹/);
    await assert.rejects(f.drafts.inspect([unsupported]), /类型不受支持/);
    await assert.rejects(f.drafts.inspect(Array(9).fill(source)), /最多添加 8 个/);
    const large = await f.file('large.txt');
    await fs.truncate(large, MAX_FILE + 1);
    await assert.rejects(f.drafts.inspect([large]), /单个附件不能超过 8 MiB/);
    await fs.truncate(large, MAX_FILE);
    await assert.rejects(f.drafts.inspect([large, large, source]), /附件合计不能超过 16 MiB/);
    await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});

test('first send rejects unselected, deleted or changed source files and allows explicit reselection', async () => {
  const f = await fixture();
  try {
    const source = await f.file('draft.txt', 'first');
    await assert.rejects(f.drafts.stage('session', [{ path: source, selectionId: randomUUID() }], () => {}), /尚未选择或选择已失效/);
    const selected = await f.drafts.inspect([source]);
    await fs.writeFile(source, 'other'); // Same length must still require reselection.
    await fs.utimes(source, new Date(1000), new Date(1000));
    await assert.rejects(f.drafts.stage('session', selected, () => {}), /选择后已变更，请重新选择/);
    await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
    const reselected = await f.drafts.inspect([source]);
    const [copy] = await f.drafts.stage('session', reselected, () => {});
    assert.equal(await fs.readFile(copy.path, 'utf8'), 'other');
    await fs.rm(source);
    await assert.rejects(f.drafts.stage('session', reselected, () => {}), /已被删除或无法读取，请重新选择/);
    assert.deepEqual(await f.manager.list('session'), [copy]);
  } finally { await f.dispose(); }
});

test('source changes during staging remove only new copies and preserve preexisting session attachments', async () => {
  const f = await fixture();
  try {
    const source = await f.file('draft.txt'), previousSource = await f.file('existing.txt');
    const [previous] = await f.manager.add('session', [previousSource]);
    const drafts = new DraftAttachments({
      add: async (id, paths) => {
        const copies = await f.manager.add(id, paths);
        await fs.writeFile(source, 'changed during copy');
        return copies;
      },
      removeFile: (id, file) => f.manager.removeFile(id, file),
    });
    const selected = await drafts.inspect([source]);
    await assert.rejects(drafts.stage('session', selected, () => {}), /选择后已变更/);
    assert.deepEqual(await f.manager.list('session'), [previous]);
    assert.deepEqual((await fs.readdir(path.dirname(previous.path))).sort(), [path.basename(previous.path), 'attachments.json'].sort());
  } finally { await f.dispose(); }
});

test('session staging permissions are rechecked and failed staging leaves the selection available for retry', async () => {
  const f = await fixture();
  try {
    const source = await f.file('draft.txt');
    const selected = await f.drafts.inspect([source]);
    await assert.rejects(f.drafts.stage('session', selected, () => { throw new Error('会话已归档'); }), /会话已归档/);
    await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
    let checks = 0;
    await assert.rejects(f.drafts.stage('session', selected, () => {
      if (++checks === 2) throw new Error('会话已归档');
    }), /会话已归档/);
    assert.deepEqual(await f.manager.list('session'), []);
    const [copy] = await f.drafts.stage('session', selected, () => {});
    assert.deepEqual(await f.manager.list('session'), [copy]);
  } finally { await f.dispose(); }
});

test('independent new and fork drafts selecting the same source retain their own original fingerprints', async () => {
  const f = await fixture();
  try {
    const source = await f.file('shared.txt', 'first');
    const initialDraft = await f.drafts.inspect([source]);
    await fs.writeFile(source, 'other');
    await fs.utimes(source, new Date(1000), new Date(1000));
    const forkDraft = await f.drafts.inspect([source]);
    assert.notEqual(initialDraft[0].selectionId, forkDraft[0].selectionId);
    assert.equal(initialDraft[0].path, forkDraft[0].path);
    await assert.rejects(f.drafts.stage('new-session', initialDraft, () => {}), /选择后已变更，请重新选择/);
    await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
    const [copy] = await f.drafts.stage('fork-session', forkDraft, () => {});
    assert.equal(await fs.readFile(copy.path, 'utf8'), 'other');
    await assert.rejects(f.drafts.stage('new-session', initialDraft, () => {}), /选择后已变更，请重新选择/);
  } finally { await f.dispose(); }
});

test('selection tokens bind the original path and ignore renderer supplied names and sizes', async () => {
  const f = await fixture();
  try {
    const source = await f.file('selected.txt'), other = await f.file('other.txt');
    const [selected] = await f.drafts.inspect([source]);
    await assert.rejects(f.drafts.stage('session', [{ ...selected, path: other }], () => {}), /路径与所选文件不一致/);
    await assert.rejects(f.drafts.stage('session', [{ ...selected, selectionId: 'not-a-token' }], () => {}), /UUID/);
    const tampered = [{ ...selected, name: 'forged.exe', bytes: 0 }];
    const [copy] = await f.drafts.stage('session', tampered, () => {});
    assert.equal(copy.name, 'selected.txt');
    assert.equal(copy.bytes, Buffer.byteLength('approved contents'));
    assert.equal(await fs.readFile(copy.path, 'utf8'), 'approved contents');
  } finally { await f.dispose(); }
});

test('the selection cache expires its oldest token while keeping recent selections usable', async () => {
  const f = await fixture();
  try {
    const source = await f.file('selected.txt');
    const oldest = await f.drafts.inspect([source]);
    const retained = await f.drafts.inspect([source]);
    for (let index = 0; index < MAX_DRAFT_ATTACHMENT_SELECTIONS - 1; index++) await f.drafts.inspect([source]);
    await assert.rejects(f.drafts.stage('session', oldest, () => {}), /选择已失效，请重新选择/);
    const [copy] = await f.drafts.stage('session', retained, () => {});
    assert.deepEqual(await f.manager.list('session'), [copy]);
  } finally { await f.dispose(); }
});
