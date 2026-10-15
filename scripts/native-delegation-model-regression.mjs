import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REGRESSION_CASES } from './native-delegation-model-regression-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function parseRegressionArguments(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--claude-config', '--model', '--protocol', '--out', '--attempts', '--cases', '--candidate-sha'].includes(argv[i]) || !argv[i + 1]) throw new Error('invalid_arguments');
    if (Object.hasOwn(args, argv[i].slice(2))) throw new Error('duplicate_argument');
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.out) throw new Error('output_directory_required');
  const attempts = Number(args.attempts ?? 3), cases = (args.cases ?? REGRESSION_CASES.join(',')).split(',');
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10 || !cases.length || cases.some(mode => !REGRESSION_CASES.includes(mode)) || new Set(cases).size !== cases.length) throw new Error('invalid_cases_or_attempts');
  const protocol = args.protocol ?? 'anthropic';
  if (!['anthropic', 'responses', 'chat-completions'].includes(protocol)) throw new Error('invalid_protocol');
  return { claudeConfig: path.resolve(args['claude-config'] ?? path.join(homedir(), '.claude', 'settings.json')), model: args.model,
    outputDirectory: path.resolve(args.out), attempts, cases, protocol, candidateSha: args['candidate-sha'] };
}

/** 构建独立 Electron 主入口，运行器复用生产 StructuredExecutor 和真实 utilityProcess。 */
export async function runDelegationModelRegression(options) {
  await mkdir(options.outputDirectory, { recursive: false });
  // 启动前只在内存检查连接是否存在，缺配置不依赖构建环境，也不泄露字段值。
  let configuration;
  try { configuration = JSON.parse(await readFile(options.claudeConfig, 'utf8')); } catch { /* 统一记录 no_config。 */ }
  const environment = configuration?.env ?? {};
  const configuredModel = options.model ?? environment.ANTHROPIC_MODEL ?? environment[`ANTHROPIC_DEFAULT_${String(configuration?.model ?? '').toUpperCase()}_MODEL`];
  if (!(environment.ANTHROPIC_AUTH_TOKEN ?? environment.ANTHROPIC_API_KEY) || !environment.ANTHROPIC_BASE_URL || !configuredModel) {
    const reportFile = path.join(options.outputDirectory, 'report.json'), report = { version: 1, source: 'real_model', status: 'not_run', releaseGate: 'not_run', reason: 'no_config', cases: [] };
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { reportFile, report, exitCode: 1 };
  }
  const safeOptions = { ...options };
  const optionsPath = path.join(options.outputDirectory, 'runtime-options.json');
  await writeFile(optionsPath, JSON.stringify(safeOptions), { flag: 'wx', mode: 0o600 });
  let exitCode = 1;
  try {
    const { build } = await import('esbuild');
    const runtime = path.join(options.outputDirectory, 'runtime');
    await build({ absWorkingDir: root, entryPoints: ['apps/desktop/scripts/native-delegation-runtime.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(runtime, 'main/regression.cjs'), external: ['electron', 'node-pty'], logLevel: 'silent' });
    await build({ absWorkingDir: root, entryPoints: ['apps/desktop/src/main/engines/native/worker-entry.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(runtime, 'native/worker.cjs'), external: ['electron'], logLevel: 'silent' });
    const { default: electron } = await import('electron');
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    exitCode = await new Promise((resolve, reject) => {
      const child = spawn(electron, [path.join(runtime, 'main/regression.cjs'), optionsPath, ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])], { cwd: root, env: environment, windowsHide: true, stdio: 'ignore' });
      child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
    });
  } catch {
    const reportPath = path.join(options.outputDirectory, 'report.json');
    await writeFile(reportPath, JSON.stringify({ version: 1, source: 'real_model', status: 'not_run', reason: 'runtime_build_or_launch_unavailable', cases: [] }, null, 2) + '\n', { flag: 'wx' }).catch(() => {});
  }
  const reportFile = path.join(options.outputDirectory, 'report.json');
  let report;
  try { report = JSON.parse(await readFile(reportFile, 'utf8')); }
  catch {
    report = { version: 1, source: 'real_model', status: 'not_run', releaseGate: 'not_run', reason: 'runtime_report_unavailable', runtimeExitCode: exitCode, cases: [] };
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return { reportFile, report, exitCode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await runDelegationModelRegression(parseRegressionArguments(process.argv.slice(2)));
    console.log(JSON.stringify({ reportFile: result.reportFile, status: result.report.status, releaseGate: result.report.releaseGate ?? 'not_run', reason: result.report.reason }));
    process.exitCode = result.exitCode === 0 && result.report.status === 'passed' ? 0 : 1;
  } catch { console.error('Native delegation regression could not start; use a fresh output directory and the existing connection configuration.'); process.exitCode = 1; }
}
