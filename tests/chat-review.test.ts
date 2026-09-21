import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Attachments } from '../src/main/attachments';
import { userContent } from '../src/main/chat-protocol';

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-review-'));

test('selected attachment snapshots are immutable copies and scoped to exactly one session', async () => {
  const directory = temporary();
  try {
    const attachments = new Attachments(directory);
    const source = path.join(directory, 'picked.txt');
    fs.writeFileSync(source, 'original selected content');
    const session = randomUUID(); const otherSession = randomUUID();
    const [selected] = await attachments.add(session, [source]);
    assert.notEqual(selected.path, source);
    fs.writeFileSync(source, 'later source change');
    assert.equal(fs.readFileSync(selected.path, 'utf8'), 'original selected content');
    assert.equal(selected.name, 'picked.txt');
    assert.deepEqual(await attachments.validate(session, [selected.path]), [selected.path]);
    await assert.rejects(attachments.validate(otherSession, [selected.path]), /不属于当前会话/);
    await assert.rejects(attachments.validate(session, [source]), /不属于当前会话/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(selected.path).mode & 0o777, 0o600);
    await attachments.remove(session);
    assert.equal(fs.existsSync(selected.path), false);
    await assert.rejects(attachments.validate(session, [selected.path]), /不属于当前会话/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('attachment selection and sending enforce file/aggregate limits and clean partial copies', async () => {
  const directory = temporary();
  try {
    const attachments = new Attachments(directory);
    const session = randomUUID();
    const oversize = path.join(directory, 'oversize.png');
    fs.writeFileSync(oversize, ''); fs.truncateSync(oversize, 8 * 1024 * 1024 + 1);
    await assert.rejects(attachments.add(session, [oversize]), /8 MiB/);
    await assert.rejects(userContent('x', [oversize]), /大小超限/);
    const files = ['a.png', 'b.png', 'c.png'].map(name => path.join(directory, name));
    for (const file of files) { fs.writeFileSync(file, ''); fs.truncateSync(file, 6 * 1024 * 1024); }
    await assert.rejects(attachments.add(session, files), /16 MiB/);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'attachments', session)), []);
    const selected = [];
    // Picking in separate native dialogs cannot bypass the total-send limit.
    for (const file of files) selected.push(...await attachments.add(session, [file]));
    await assert.rejects(attachments.validate(session, selected.map(item => item.path)), /16 MiB/);
    fs.truncateSync(selected[0].path, 8 * 1024 * 1024 + 1);
    await assert.rejects(attachments.validate(session, [selected[0].path]), /已变更/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('replacing an approved copy with a symlink is rejected at the send boundary', { skip: process.platform === 'win32' }, async () => {
  const directory = temporary();
  try {
    const attachments = new Attachments(directory);
    const source = path.join(directory, 'picked.md');
    const secret = path.join(directory, 'unselected-secret.md');
    fs.writeFileSync(source, 'selected'); fs.writeFileSync(secret, 'private');
    const session = randomUUID();
    const [selected] = await attachments.add(session, [source]);
    fs.unlinkSync(selected.path); fs.symlinkSync(secret, selected.path);
    await assert.rejects(attachments.validate(session, [selected.path]), /已变更/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
