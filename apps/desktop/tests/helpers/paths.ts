import path from 'node:path';

// tsx 和 Playwright 都会将桌面测试转换为 CommonJS。
// 根据文件位置解析路径，不依赖调用者的工作目录。
export const desktopRoot = path.resolve(__dirname, '../..');
export const repositoryRoot = path.resolve(desktopRoot, '../..');
export const documentationPath = (...parts: string[]) => path.join(repositoryRoot, 'docs', ...parts);
export const testResultsPath = (...parts: string[]) => path.join(repositoryRoot, 'test-results', ...parts);
