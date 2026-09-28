#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageFile = '{"name":"native-eval-fixture","private":true,"type":"module","scripts":{"test":"node --test"}}\n';
const TASKS = [
  {
    id: 'bug-fix', directory: '01-bug-fix', title: '修复 clamp 边界处理',
    prompt: '修复 src/range.mjs 的 clamp(value, min, max)。闭区间内值保持不变，超界值截到相应边界；三个参数必须是有限数字，否则抛 TypeError；min > max 抛 RangeError。保持导出名称和已有测试文件内容，在 test/range-regression.test.mjs 中补充测试并运行，说明差异。',
    files: {
      'package.json': packageFile,
      'src/range.mjs': 'export function clamp(value, min, max) {\n  return Math.min(min, Math.max(max, value));\n}\n',
      'test/range.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from '../src/range.mjs';\ntest('keeps an interior value', () => assert.equal(clamp(5, 0, 10), 5));\n",
    },
    oracle: `const { clamp } = await load('src/range.mjs');
for (const [value, min, max, expected] of [[5,0,10,5],[-2,0,10,0],[12,0,10,10],[0,0,10,0],[10,0,10,10],[-2,-4,-1,-2],[1.5,1,2,1.5],[2,2,2,2]]) assert.equal(clamp(value,min,max), expected);
for (const args of [[NaN,0,1],[1,0,Infinity],['1',0,2],[0,undefined,2]]) assert.throws(() => clamp(...args), TypeError);
assert.throws(() => clamp(1,3,2), RangeError);
assert.ok((await fs.readFile(path.join(root,'test/range-regression.test.mjs'),'utf8')).trim().length > 0, 'Add the requested regression tests');`,
  },
  {
    id: 'small-feature', directory: '02-small-feature', title: '增加 groupBy 并补测试',
    prompt: '在 src/collections.mjs 中增加 groupBy(items, keyOf)。items 必须是数组，keyOf 必须是函数，否则抛 TypeError。返回无原型对象，以 String(keyOf(item, index)) 分组，保留组内原始项的顺序和身份，不修改输入；__proto__ 也必须是普通键。保持现有 sum 行为和已有测试文件内容。在 test/group-by.test.mjs 中补充测试并运行。',
    files: {
      'package.json': packageFile,
      'src/collections.mjs': 'export function sum(values) { return values.reduce((total, value) => total + value, 0); }\n',
      'test/collections.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../src/collections.mjs';\ntest('sums values', () => assert.equal(sum([2, 3, 5]), 10));\n",
    },
    oracle: `const { groupBy, sum } = await load('src/collections.mjs');
assert.equal(sum([2,3,5]), 10); assert.equal(typeof groupBy, 'function');
const a = Object.freeze({kind:'a'}), b = Object.freeze({kind:'b'}); const items = Object.freeze([a,b,a]);
const groups = groupBy(items, item => item.kind); assert.equal(Object.getPrototypeOf(groups), null);
assert.deepEqual(groups.a, [a,a]); assert.deepEqual(groups.b, [b]); assert.equal(groups.a[0], a);
assert.deepEqual(groupBy([], x => x), Object.create(null));
const special = groupBy([a,b], () => '__proto__'); assert.deepEqual(special.__proto__, [a,b]);
assert.deepEqual(groupBy([a,b], (_, index) => index)['1'], [b]);
assert.throws(() => groupBy(null, x => x), TypeError); assert.throws(() => groupBy([], null), TypeError);
assert.ok((await fs.readFile(path.join(root, 'test/group-by.test.mjs'), 'utf8')).trim().length > 0, 'Add the requested feature tests');`,
  },
  {
    id: 'instruction-refactor', directory: '03-instruction-refactor', title: '遵守分层指令去除重复格式化',
    prompt: '按适用的 CLAUDE.md 与 AGENTS.md 约定，提取 src/report.mjs 和 src/item.mjs 中重复的数量格式化。保持 report、itemLabel 输出和导出不变，两个模块都调用共享函数；不要改指令文件和已有测试文件。运行测试并解释所遵循的来源与作用域。',
    files: {
      'package.json': packageFile,
      'CLAUDE.md': 'Preserve public behavior. Prefer placing new shared utilities in helpers/.\n',
      'AGENTS.md': 'Use ES modules and named exports. Preserve instruction files and existing tests. Deeper directory rules override this root guidance.\n',
      'src/CLAUDE.md': 'For this directory, extract quantity formatting into legacy-quantity.mjs.\n',
      'src/AGENTS.md': 'For this directory, shared quantity formatting belongs in quantity.mjs and exports formatQuantity(value). Import it as a named export in both report.mjs and item.mjs. This rule takes precedence over src/CLAUDE.md. Do not create legacy-quantity.mjs.\n',
      'src/report.mjs': 'export function report(value) { return `Total: ${value.toFixed(2)} kg`; }\n',
      'src/item.mjs': 'export function itemLabel(name, value) { return `${name}: ${value.toFixed(2)} kg`; }\n',
      'test/format.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { report } from '../src/report.mjs';\nimport { itemLabel } from '../src/item.mjs';\ntest('keeps public labels', () => { assert.equal(report(1.2), 'Total: 1.20 kg'); assert.equal(itemLabel('Rice', 2), 'Rice: 2.00 kg'); });\n",
    },
    oracle: `const { formatQuantity } = await load('src/quantity.mjs');
const { report } = await load('src/report.mjs'); const { itemLabel } = await load('src/item.mjs');
for (const value of [0,1.2,-3,2.345]) { const text = value.toFixed(2) + ' kg'; assert.equal(formatQuantity(value), text); assert.equal(report(value), 'Total: ' + text); assert.equal(itemLabel('Rice', value), 'Rice: ' + text); }
for (const file of ['src/report.mjs','src/item.mjs']) { const text = await fs.readFile(path.join(root,file),'utf8'); assert.match(text, /import\\s*\\{\\s*formatQuantity\\s*\\}\\s*from\\s*['"]\\.\\/quantity\\.mjs['"]/); assert.doesNotMatch(text, /\\.toFixed\\s*\\(/); }
await assert.rejects(fs.stat(path.join(root,'src/legacy-quantity.mjs')), { code:'ENOENT' });`,
  },
];

const sha256 = value => createHash('sha256').update(value).digest('hex');
export const SUITE = Object.freeze({ version: 1, hash: sha256(JSON.stringify(TASKS)), tasks: TASKS.map(({ id, directory, title }) => ({ id, directory, title })) });
const MAX_JSON_BYTES = 1024 * 1024;
const commandEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LANG|LC_ALL)$/i.test(key)));
function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...commandEnvironment(), ...extraEnv }, encoding: 'utf8', timeout: 15_000, maxBuffer: MAX_JSON_BYTES, windowsHide: true });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? '\n' + result.error.message : ''}`;
  return { status: result.status === 0 && !result.error ? 'pass' : 'fail', exitCode: result.status, signal: result.signal, output: output.slice(0, 24_000), outputTruncated: output.length > 24_000 };
}
function git(directory, args) {
  return run('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.git/no-hooks', '-c', 'commit.gpgsign=false', '-c', 'user.name=Native evaluation', '-c', 'user.email=native-eval@example.invalid', ...args], directory,
    { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });
}
function requirePass(result, description) { if (result.status !== 'pass') throw new Error(`${description}: ${result.output}`); return result.output.trim(); }
async function ordinaryDirectory(directory) {
  const absolute = path.resolve(directory), stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(absolute) !== absolute) throw new Error('Evaluation directory must be an ordinary directory without path aliases.');
  return absolute;
}
async function readJson(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) throw new Error('Invalid or oversized evaluation metadata file.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function writeJsonAtomically(file, value) {
  const temporary = path.join(path.dirname(file), `.native-eval-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // rename replaces an existing symlink itself, never follows its destination.
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
export function defaultAssessment() {
  return { engine: 'unspecified', model: null, protocol: null, appRevision: null, configuration: null, tasks: Object.fromEntries(TASKS.map(task => [task.id, {
    evidence: { kind: 'pending', reference: '' }, usage: { inputTokens: null, outputTokens: null, costAmount: null, currency: null }, durationMs: null, manualInterventions: null, notes: '',
  }])) };
}
export async function prepareEvaluation(directory) {
  const absolute = path.resolve(directory);
  await fs.mkdir(absolute, { recursive: true });
  const root = await ordinaryDirectory(absolute);
  if ((await fs.readdir(root)).length) throw new Error('Refusing to prepare a nonempty directory. Choose a new empty evaluation directory.');
  const manifest = { suite: { version: SUITE.version, hash: SUITE.hash }, createdAt: new Date().toISOString(), tasks: [] };
  for (const task of TASKS) {
    const cwd = path.join(root, task.directory);
    await fs.mkdir(cwd);
    for (const [relative, content] of Object.entries({ ...task.files, 'TASK.md': `# ${task.title}\n\n${task.prompt}\n` })) {
      const file = path.join(cwd, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, { flag: 'wx' });
    }
    requirePass(git(cwd, ['init', '--initial-branch=main']), 'Initialize fixture repository');
    requirePass(git(cwd, ['add', '--all']), 'Stage baseline');
    requirePass(git(cwd, ['commit', '-m', 'Fixed evaluation baseline']), 'Commit baseline');
    const baselineCommit = requirePass(git(cwd, ['rev-parse', 'HEAD']), 'Read baseline commit');
    manifest.tasks.push({ id: task.id, directory: task.directory, baselineCommit });
  }
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(root, 'assessment.json'), JSON.stringify(defaultAssessment(), null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
const nullableNumber = (value, integer = false) => value === null || value === undefined ? null : typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : (() => { throw new Error('Assessment metrics must be finite nonnegative numbers or null.'); })();
function assessmentFor(input, id) {
  const task = input?.tasks?.[id] ?? {};
  const kind = task.evidence?.kind ?? 'pending';
  if (!['pending', 'local-fixture', 'manual-real'].includes(kind)) throw new Error('Invalid evidence kind.');
  const reference = task.evidence?.reference ?? '', notes = task.notes ?? '';
  if (typeof reference !== 'string' || reference.length > 2000 || typeof notes !== 'string' || notes.length > 8000) throw new Error('Assessment text must be bounded strings.');
  if (kind === 'manual-real' && !reference.trim()) throw new Error('Manual real-service evidence requires a reference.');
  const currency = task.usage?.currency ?? null;
  if (currency !== null && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) throw new Error('Cost currency must be an uppercase three-letter code or null.');
  const costAmount = nullableNumber(task.usage?.costAmount);
  if (costAmount !== null && currency === null) throw new Error('A cost amount requires an explicit currency.');
  return { evidence: { kind, reference }, usage: { inputTokens: nullableNumber(task.usage?.inputTokens, true), outputTokens: nullableNumber(task.usage?.outputTokens, true), costAmount, currency }, durationMs: nullableNumber(task.durationMs), manualInterventions: nullableNumber(task.manualInterventions, true), notes };
}
function runMetadata(input) {
  const { engine = 'unspecified', model = null, protocol = null, appRevision = null, configuration = null } = input;
  if (typeof engine !== 'string' || engine.length > 100 || [model, protocol, appRevision].some(value => value !== null && (typeof value !== 'string' || value.length > 200))) throw new Error('Invalid assessment engine/model/protocol/revision metadata.');
  if (configuration !== null && (typeof configuration !== 'object' || Array.isArray(configuration) || Object.keys(configuration).length !== 1 || typeof configuration.reference !== 'string' || !configuration.reference.trim() || configuration.reference.length > 2000)) throw new Error('Configuration must be null or a bounded reference object.');
  return { engine, model, protocol, appRevision, configuration };
}
function assertSuite(value) {
  if (value?.version !== SUITE.version || value?.hash !== SUITE.hash) throw new Error('Suite version/hash mismatch; use the matching evaluator or prepare a new suite.');
}
const oracleProgram = oracle => `import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const root = process.argv[1]; const load = file => import(pathToFileURL(path.join(root,file)).href);
${oracle}
console.log('Immutable acceptance checks passed.');`;
export async function verifyEvaluation(directory) {
  const root = await ordinaryDirectory(directory), manifest = await readJson(path.join(root, 'manifest.json'));
  assertSuite(manifest.suite);
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length !== TASKS.length) throw new Error('Evaluation manifest has unexpected tasks.');
  const rawAssessment = await readJson(path.join(root, 'assessment.json')).catch(error => { if (error.code === 'ENOENT') return defaultAssessment(); throw error; });
  const report = { schemaVersion: 1, suite: manifest.suite, generatedAt: new Date().toISOString(), ...runMetadata(rawAssessment), tasks: [], functionalStatus: 'pass', realQualityStatus: 'pending' };
  for (const task of TASKS) {
    const entry = manifest.tasks.find(item => item.id === task.id);
    if (!entry || entry.directory !== task.directory || !/^[a-f0-9]{40,64}$/.test(entry.baselineCommit)) throw new Error('Invalid fixture baseline metadata.');
    const cwd = await ordinaryDirectory(path.join(root, task.directory));
    for (const [relative, content] of Object.entries({ ...task.files, 'TASK.md': `# ${task.title}\n\n${task.prompt}\n` })) {
      const baseline = git(cwd, ['show', `${entry.baselineCommit}:${relative}`]);
      if (baseline.status !== 'pass' || baseline.output !== content) throw new Error(`Baseline content mismatch for ${task.id}/${relative}.`);
    }
    const protectedSources = Object.entries(task.files).filter(([name]) => /(?:^|\/)(?:AGENTS|CLAUDE)\.md$|\.test\.mjs$/.test(name));
    const changedProtectedFiles = [];
    for (const [relative, content] of protectedSources) {
      try { if (await fs.readFile(path.join(cwd, relative), 'utf8') !== content) changedProtectedFiles.push(relative); }
      catch { changedProtectedFiles.push(relative); }
    }
    const started = Date.now();
    const tests = run(process.execPath, ['--test'], cwd);
    const oracle = run(process.execPath, ['--input-type=module', '-e', oracleProgram(task.oracle), cwd], cwd);
    const diff = git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--binary', entry.baselineCommit, '--', '.']);
    const status = git(cwd, ['status', '--short', '--untracked-files=all']);
    const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
    const addedFiles = [], addedPaths = untracked.output.split('\0').filter(Boolean);
    for (const relative of addedPaths.slice(0, 64)) {
      const file = path.join(cwd, relative), stat = await fs.lstat(file);
      addedFiles.push({ path: relative, bytes: stat.size, hash: stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_JSON_BYTES ? sha256(await fs.readFile(file)) : null });
    }
    const assessment = assessmentFor(rawAssessment, task.id);
    const functionalStatus = [tests, oracle, diff, status, untracked].every(result => result.status === 'pass') && !changedProtectedFiles.length ? 'pass' : 'fail';
    if (functionalStatus === 'fail') report.functionalStatus = 'fail';
    report.tasks.push({ id: task.id, title: task.title, functionalStatus, tests, oracle, changedProtectedFiles, changedInstructions: changedProtectedFiles.filter(name => /(?:AGENTS|CLAUDE)\.md$/.test(name)), diff, workingTree: status.output, addedFiles, addedFilesTruncated: untracked.outputTruncated || addedPaths.length > 64,
      verificationDurationMs: Date.now() - started, assessment, realQuality: { status: 'pending', evidenceKind: assessment.evidence.kind, manualReviewRequired: true,
        reason: assessment.evidence.kind === 'manual-real' ? 'User-supplied service evidence must be reviewed separately; local checks do not establish model task quality.' : 'No independently reviewed real-service task evidence.' } });
  }
  await writeJsonAtomically(path.join(root, 'report.json'), report);
  return report;
}
export async function compareReports(leftFile, rightFile) {
  const left = await readJson(leftFile), right = await readJson(rightFile);
  for (const report of [left, right]) {
    assertSuite(report.suite);
    if (report.schemaVersion !== 1 || !Array.isArray(report.tasks) || report.tasks.length !== TASKS.length || new Set(report.tasks.map(task => task.id)).size !== TASKS.length) throw new Error('Invalid evaluation report.');
  }
  return { suite: left.suite, left: runMetadata(left), right: runMetadata(right),
    tasks: TASKS.map(({ id }) => {
      const a = left.tasks.find(task => task.id === id), b = right.tasks.find(task => task.id === id);
      if (!a || !b) throw new Error('Reports have different tasks.');
      for (const task of [a, b]) {
        if (!['pass', 'fail'].includes(task.functionalStatus) || task.realQuality?.status !== 'pending') throw new Error('Invalid functional status or unsupported real-quality verdict.');
        assessmentFor({ tasks: { [id]: task.assessment } }, id);
      }
      const fields = task => ({ functionalStatus: task.functionalStatus, evidence: task.assessment.evidence, usage: task.assessment.usage, durationMs: task.assessment.durationMs, manualInterventions: task.assessment.manualInterventions, realQualityStatus: task.realQuality.status });
      return { id, left: fields(a), right: fields(b) };
    }), verdict: 'manual-review-required', note: 'Unknown metrics remain null. Functional checks and self-reported model evidence are separate; no engine default is changed.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, first, second] = process.argv.slice(2);
  try {
    if (command === 'prepare' && first && !second) console.log(JSON.stringify(await prepareEvaluation(first), null, 2));
    else if (command === 'verify' && first && !second) { const report = await verifyEvaluation(first); console.log(JSON.stringify({ report: path.resolve(first, 'report.json'), functionalStatus: report.functionalStatus, realQualityStatus: report.realQualityStatus }, null, 2)); process.exitCode = report.functionalStatus === 'pass' ? 0 : 1; }
    else if (command === 'compare' && first && second) console.log(JSON.stringify(await compareReports(first, second), null, 2));
    else throw new Error('Usage: node scripts/native-eval.mjs prepare <empty-directory> | verify <directory> | compare <left-report.json> <right-report.json>');
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
