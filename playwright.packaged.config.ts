import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: 'packaged.spec.ts',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/packaged',
  reporter: [['list'], ['json', { outputFile: 'test-results/packaged-results.json' }]],
});
