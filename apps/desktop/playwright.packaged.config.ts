import { defineConfig } from '@playwright/test';
import { testResultsPath } from './tests/helpers/paths';

export default defineConfig({
  testDir: 'tests',
  testMatch: 'packaged.spec.ts',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: testResultsPath('packaged'),
  reporter: [['list'], ['json', { outputFile: testResultsPath('packaged-results.json') }]],
});
