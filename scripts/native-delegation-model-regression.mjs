import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_REGRESSION_CASES, REGRESSION_CASES } from './native-delegation-model-regression-lib.mjs';
import { cleanupNativeCredentialProfile, prepareNativeCredentialProfile, verifyNativeProfileSourceUnchanged } from './native-credential-profile.mjs';
import { fingerprintRegressionBundleInputs, readRegressionCandidateBinding } from './native-regression-candidate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function parseRegressionArguments(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--claude-config', '--model', '--protocol', '--out', '--attempts', '--cases', '--candidate-sha', '--native-data-dir', '--connection-id', '--native-session-id', '--native-profile-key'].includes(argv[i]) || !argv[i + 1]) throw new Error('invalid_arguments');
    if (Object.hasOwn(args, argv[i].slice(2))) throw new Error('duplicate_argument');
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.out) throw new Error('output_directory_required');
  const attempts = Number(args.attempts ?? 3), cases = (args.cases ?? DEFAULT_REGRESSION_CASES.join(',')).split(',');
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10 || !cases.length || cases.some(mode => !REGRESSION_CASES.includes(mode)) || new Set(cases).size !== cases.length) throw new Error('invalid_cases_or_attempts');
  const protocol = args.protocol ?? 'anthropic';
  if (!['anthropic', 'responses', 'chat-completions'].includes(protocol)) throw new Error('invalid_protocol');
  if ((args['connection-id'] || args['native-session-id']) && !args['native-data-dir']) throw new Error('native_data_directory_required');
  if (args['native-profile-key'] !== undefined && args['native-profile-key'] !== 'true') throw new Error('invalid_native_profile_key_option');
  if (args['native-profile-key'] && !args['native-data-dir']) throw new Error('native_data_directory_required');
  if (args['candidate-sha'] && !/^[a-f\d]{40}$/iu.test(args['candidate-sha'])) throw new Error('invalid_candidate_revision');
  for (const key of ['connection-id', 'native-session-id']) if (args[key] && !/^[a-zA-Z0-9_-]{1,100}$/.test(args[key])) throw new Error('invalid_native_selection');
  return { claudeConfig: path.resolve(args['claude-config'] ?? path.join(homedir(), '.claude', 'settings.json')), model: args.model,
    outputDirectory: path.resolve(args.out), attempts, cases, protocol, candidateSha: args['candidate-sha'],
    ...(args['native-data-dir'] ? { nativeDataDirectory: path.resolve(args['native-data-dir']) } : {}), ...(args['connection-id'] ? { connectionId: args['connection-id'] } : {}), ...(args['native-session-id'] ? { nativeSessionId: args['native-session-id'] } : {}), ...(args['native-profile-key'] ? { nativeProfileKey: true } : {}) };
}

/** 构建独立 Electron 主入口，运行器复用生产 StructuredExecutor 和真实 utilityProcess。 */
export async function runDelegationModelRegression(options) {
  await mkdir(options.outputDirectory, { recursive: false });
  const candidateBinding = await readRegressionCandidateBinding(root, options.candidateSha);
  let buildProvenance;
  // 启动前只在内存检查连接是否存在，缺配置不依赖构建环境，也不泄露字段值。
  let configuration;
  if (!options.nativeDataDirectory) try { configuration = JSON.parse(await readFile(options.claudeConfig, 'utf8')); } catch { /* 统一记录 no_config。 */ }
  const environment = configuration?.env ?? {};
  if (!options.nativeDataDirectory && !(environment.ANTHROPIC_AUTH_TOKEN ?? environment.ANTHROPIC_API_KEY)) {
    const reportFile = path.join(options.outputDirectory, 'report.json'), report = { version: 1, source: 'real_model', status: 'not_run', releaseGate: 'not_run', reason: 'no_config', candidateBinding, cases: [] };
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { reportFile, report, exitCode: 1 };
  }
  const optionsPath = path.join(options.outputDirectory, 'runtime-options.json');
  let exitCode = 1, credentialProfile, profileEvidence = options.nativeProfileKey ? { requested: true, created: false, cleanupConfirmed: false, sourceFilesUnchanged: null, checkedFiles: 0 } : undefined;
  try {
    if (options.nativeProfileKey) {
      credentialProfile = await prepareNativeCredentialProfile({ nativeDataDirectory: options.nativeDataDirectory });
      profileEvidence.created = true;
    }
    const { build } = await import('esbuild');
    const runtime = path.join(options.outputDirectory, 'runtime');
    const mainBuild = await build({ absWorkingDir: root, entryPoints: ['apps/desktop/scripts/native-delegation-runtime.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(runtime, 'main/regression.cjs'), external: ['electron', 'node-pty'], logLevel: 'silent', metafile: true });
    const workerBuild = await build({ absWorkingDir: root, entryPoints: ['apps/desktop/src/main/engines/native/worker-entry.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(runtime, 'native/worker.cjs'), external: ['electron'], logLevel: 'silent', metafile: true });
    buildProvenance = await fingerprintRegressionBundleInputs(root, [mainBuild.metafile, workerBuild.metafile]);
    const safeOptions = { ...options, candidateBinding, buildProvenance, ...(credentialProfile ? { credentialProfileDirectory: credentialProfile.directory } : {}) };
    await writeFile(optionsPath, JSON.stringify(safeOptions), { flag: 'wx', mode: 0o600 });
    const { default: electron } = await import('electron');
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    exitCode = await new Promise((resolve, reject) => {
      const child = spawn(electron, [path.join(runtime, 'main/regression.cjs'), optionsPath, ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])], { cwd: root, env: environment, windowsHide: true, stdio: 'ignore' });
      child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
    });
  } catch (error) {
    const reportPath = path.join(options.outputDirectory, 'report.json');
    const reason = typeof error?.code === 'string' && /^native_profile_(?:key_missing|key_invalid|key_unsupported|source_unsafe|source_changed|cleanup_refused)$/.test(error.code) ? error.code : 'runtime_build_or_launch_unavailable';
    await writeFile(reportPath, JSON.stringify({ version: 1, source: 'real_model', status: 'not_run', reason, cases: [] }, null, 2) + '\n', { flag: 'wx' }).catch(() => {});
  } finally {
    if (credentialProfile) {
      try { Object.assign(profileEvidence, await verifyNativeProfileSourceUnchanged(credentialProfile)); } catch { profileEvidence.sourceFilesUnchanged = false; }
      try { profileEvidence.cleanupConfirmed = await cleanupNativeCredentialProfile(credentialProfile); } catch { profileEvidence.cleanupConfirmed = false; }
    }
  }
  const reportFile = path.join(options.outputDirectory, 'report.json');
  let report;
  try { report = JSON.parse(await readFile(reportFile, 'utf8')); }
  catch {
    report = { version: 1, source: 'real_model', status: 'not_run', releaseGate: 'not_run', reason: 'runtime_report_unavailable', runtimeExitCode: exitCode, cases: [] };
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  report.candidateBinding = candidateBinding;
  const candidateBindingAfterRun = await readRegressionCandidateBinding(root, options.candidateSha);
  report.candidateBindingAfterRun = candidateBindingAfterRun;
  if (buildProvenance) report.buildProvenance = buildProvenance;
  const candidateStable = candidateBinding.verified && candidateBindingAfterRun.verified && candidateBinding.actualHead === candidateBindingAfterRun.actualHead;
  if (!candidateStable) { report.releaseGate = 'not_run'; report.releaseGateReason = !candidateBinding.verified ? candidateBinding.reason : candidateBindingAfterRun.reason; }
  if (profileEvidence) {
    report.credentialProfile = profileEvidence;
    if (profileEvidence.created && (!profileEvidence.cleanupConfirmed || !profileEvidence.sourceFilesUnchanged)) { report.status = 'failed'; report.releaseGate = candidateStable ? 'failed' : 'not_run'; report.reason = !profileEvidence.cleanupConfirmed ? 'credential_profile_cleanup_unconfirmed' : 'native_profile_source_changed'; }
  }
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return { reportFile, report, exitCode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await runDelegationModelRegression(parseRegressionArguments(process.argv.slice(2)));
    console.log(JSON.stringify({ reportFile: result.reportFile, status: result.report.status, releaseGate: result.report.releaseGate ?? 'not_run', reason: result.report.reason }));
    process.exitCode = result.exitCode === 0 && result.report.status === 'passed' ? 0 : 1;
  } catch { console.error('Native delegation regression could not start; use a fresh output directory and the existing connection configuration.'); process.exitCode = 1; }
}
