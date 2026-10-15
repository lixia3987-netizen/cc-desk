import type { EnvironmentDiagnostics } from '../shared/diagnostics';
import type { HistoryPage } from '../shared/types';

/** 只读提供方集成由组合根提供。 */
export interface WorkspaceQueries {
  history(cwd: string, options: { providerId?: string; query?: string; offset?: number; limit?: number }): Promise<HistoryPage>;
  diagnose(cwd?: string): Promise<EnvironmentDiagnostics>;
}
