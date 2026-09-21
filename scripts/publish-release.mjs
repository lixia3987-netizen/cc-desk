import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const repository = process.env.GITHUB_REPOSITORY;
const commit = process.env.GITHUB_SHA;
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '')) {
  throw new Error('Release version, repository or source commit is invalid.');
}
const tag = `v${version}`;
const directory = path.resolve('release-assets');
const names = (await fs.readdir(directory)).sort();
const prefix = `cc-desk-${version}-`;
const expected = [
  `${prefix}windows-x64-setup.exe`,
  `${prefix}windows-x64-portable.exe`,
  `${prefix}windows-x64-portable.zip`,
  // AppImage expands ${arch} using Linux's x86_64 name; archive targets use x64.
  `${prefix}linux-x86_64-portable.AppImage`,
  `${prefix}linux-x64-portable.tar.gz`,
];
const macArchitectures = ['arm64', 'x64'].filter(arch => names.includes(`${prefix}macos-${arch}-setup.dmg`));
if (macArchitectures.length !== 1) throw new Error('Expected one matching macOS architecture.');
expected.push(`${prefix}macos-${macArchitectures[0]}-setup.dmg`, `${prefix}macos-${macArchitectures[0]}-portable.zip`);
if (JSON.stringify([...expected].sort()) !== JSON.stringify(names)) throw new Error(`Unexpected or missing release packages: ${names.join(', ')}`);
const checksums = [];
for (const name of names) {
  const file = path.join(directory, name);
  if ((await fs.stat(file)).size < 1024 * 1024) throw new Error(`Package is unexpectedly small: ${name}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  checksums.push(`${hash.digest('hex')}  ${name}`);
}
await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
names.push('SHA256SUMS.txt');

const gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const api = endpoint => JSON.parse(gh(['api', `repos/${repository}/${endpoint}`]));
const optional = endpoint => {
  try { return api(endpoint); }
  catch (error) {
    if (/HTTP 404/.test(String(error.stderr))) return undefined;
    throw error;
  }
};
const existingTag = optional(`git/ref/tags/${tag}`);
if (existingTag && api(`commits/${tag}`).sha !== commit) throw new Error('Existing tag points to another commit; refusing to move it.');
// The tag endpoint is for published releases; list also includes drafts for this token.
const findRelease = () => {
  const pages = JSON.parse(gh(['api', `repos/${repository}/releases?per_page=100`, '--paginate', '--slurp']));
  const matches = pages.flat().filter(item => item.tag_name === tag);
  if (matches.length > 1) throw new Error('Multiple releases use this tag; refusing an ambiguous update.');
  return matches[0];
};
let release = findRelease();
if (release && (!release.draft || release.target_commitish !== commit)) throw new Error('Release already published or belongs to another commit; refusing to replace it.');

const notesDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-release-'));
try {
  const notes = await fs.readFile(`docs/releases/${tag}.md`, 'utf8');
  const notesFile = path.join(notesDirectory, 'notes.md');
  await fs.writeFile(notesFile, `${notes}\n\n源码提交：\`${commit}\`\n\n[构建与验证记录](https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID})\n`);
  if (!release) {
    gh(['release', 'create', tag, '--repo', repository, '--target', commit, '--title', `Claude Workbench ${tag}`, '--notes-file', notesFile, '--draft']);
    release = findRelease();
  }
  if (!release?.draft || release.target_commitish !== commit) throw new Error('Expected a draft for the verified source commit.');
  const releaseId = release.id;
  gh(['release', 'upload', tag, ...names.map(name => path.join(directory, name)), '--repo', repository, '--clobber']);
  release = api(`releases/${releaseId}`);
  if (release.assets.length !== names.length) throw new Error('Release asset count mismatch; leaving it as a draft.');
  for (const name of names) {
    const asset = release.assets.find(item => item.name === name);
    if (!asset || asset.state !== 'uploaded' || asset.size !== (await fs.stat(path.join(directory, name))).size) {
      throw new Error(`Release asset verification failed: ${name}; leaving it as a draft.`);
    }
  }
  gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest']);
  if (api(`releases/${releaseId}`).draft || api(`commits/${tag}`).sha !== commit) {
    throw new Error('Published release or tag does not match the verified source commit.');
  }
  console.log(`Published https://github.com/${repository}/releases/tag/${tag}`);
} finally {
  await fs.rm(notesDirectory, { recursive: true, force: true });
}
