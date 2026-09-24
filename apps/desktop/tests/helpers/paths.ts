import path from 'node:path';

// Desktop tests are transformed as CommonJS by both tsx and Playwright.
// Resolve from the file rather than the caller's working directory.
export const desktopRoot = path.resolve(__dirname, '../..');
export const repositoryRoot = path.resolve(desktopRoot, '../..');
export const documentationPath = (...parts: string[]) => path.join(repositoryRoot, 'docs', ...parts);
export const testResultsPath = (...parts: string[]) => path.join(repositoryRoot, 'test-results', ...parts);
