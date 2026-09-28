import path from 'node:path';

export const ENGINEERING_USAGE = 'engineering-init <empty-operator-directory> <40-character-app-commit> | engineering-verify <operator-directory> <run-id> <candidate-directory> [--timeout-ms <1..300000>] | engineering-report <operator-directory> <new-report.json> | engineering-compare <left-report.json> <right-report.json>';

/** Engineering commands are separate from the original three smoke-task commands. */
export async function engineeringCommand(args) {
  const [command, first, second, third] = args;
  if (command === 'engineering-init' && args.length === 3) {
    const { initializeEngineeringBatch } = await import('./native-eval-engineering-reports.mjs');
    const value = await initializeEngineeringBatch(first, second);
    return { exitCode: 0, output: { directory: path.resolve(first), ...value } };
  }
  if (command === 'engineering-report' && args.length === 3) {
    const { generateEngineeringReport } = await import('./native-eval-engineering-reports.mjs');
    const value = await generateEngineeringReport(first, second);
    return { exitCode: 0, output: { report: path.resolve(second), ...value } };
  }
  if (command === 'engineering-compare' && args.length === 3) {
    const { compareEngineeringReports } = await import('./native-eval-engineering-reports.mjs');
    return { exitCode: 0, output: await compareEngineeringReports(first, second) };
  }
  if (command === 'engineering-verify' && (args.length === 4 || args.length === 6 && args[4] === '--timeout-ms')) {
    const timeoutMs = args.length === 6 ? Number(args[5]) : undefined;
    if (timeoutMs !== undefined && (!/^\d+$/.test(args[5]) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)) throw new Error('Engineering timeout must be an integer from 1 to 300000 milliseconds.');
    const { verifyEngineeringRun } = await import('./native-eval-engineering-runner.mjs');
    const controller = new AbortController(), abort = () => controller.abort();
    process.on('SIGINT', abort); process.on('SIGTERM', abort);
    try {
      const { attemptDirectory, result } = await verifyEngineeringRun({ batchDirectory: first, runId: second, candidateDirectory: third, timeoutMs, signal: controller.signal });
      return { exitCode: result.verification.status === 'pass' ? 0 : 1, output: {
        attempt: attemptDirectory, verificationStatus: result.verification.status,
        cleanupConfirmed: result.verification.cleanupConfirmed, realQualityStatus: 'pending',
      } };
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  }
  throw new Error('Usage: node scripts/native-eval.mjs ' + ENGINEERING_USAGE);
}
