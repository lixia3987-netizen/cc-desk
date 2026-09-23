import type { EnvironmentDiagnostics } from '../shared/diagnostics';
import type { HistoryPage } from '../shared/types';

/** Read-only provider integrations are supplied by the composition root. */
export interface WorkspaceQueries {
  history(cwd: string, options: { query?: string; offset?: number; limit?: number }): Promise<HistoryPage>;
  diagnose(cwd?: string): Promise<EnvironmentDiagnostics>;
}
