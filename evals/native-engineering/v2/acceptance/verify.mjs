import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { assertIntegrity, runSelectedTests } from './common.mjs';
import snapshot from './snapshot-refresh.mjs';
import session from './session-info.mjs';
import canonical from './canonical-json.mjs';

const checks = { '01-snapshot-refresh': snapshot, '02-session-info': session, '03-canonical-json': canonical };
export async function verify(task, candidate, { integrity = true, tests = true } = {}) {
  if (!checks[task]) throw new Error('Unknown engineering task');
  const root = await fs.realpath(path.resolve(candidate));
  const protectedResult = integrity ? await assertIntegrity(root, task) : { note: 'oracle-only fixture preparation check, not candidate acceptance' };
  const oracle = await checks[task](root);
  const testResults = tests ? runSelectedTests(root, task) : [{ note: 'oracle-only preparation check; original/new tests not executed' }];
  return { task, functionalStatus: 'pass', integrity: protectedResult, ...oracle, testResults, realQualityStatus: 'pending', graphicalAcceptance: 'pending', independentHumanReview: 'required' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await verify(process.argv[2], process.argv[3]), null, 2)); }
  catch (error) { console.error(JSON.stringify({ functionalStatus: 'fail', error: error.message, realQualityStatus: 'pending' })); process.exitCode = 1; }
}
