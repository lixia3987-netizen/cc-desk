export type DiagnosticScope = 'user' | 'project' | 'local';

/** Read-only discovery. Configured credentials and endpoints are never proof of connectivity. */
export interface EnvironmentDiagnostics {
  checkedAt: number;
  cli: { installed: boolean; binary: string; version?: string; runnable?: boolean };
  auth: {
    state: 'authenticated' | 'unauthenticated' | 'unknown' | 'unsupported' | 'unavailable';
    method?: string;
    message: string;
  };
  provider: {
    origin?: string;
    origins?: Array<{ origin: string; source: string }>;
    env: Array<{ name: string; present: boolean; source: string }>;
    verified: false;
  };
  configs: Array<{
    scope: DiagnosticScope;
    path: string;
    status: 'found' | 'missing' | 'invalid';
    message?: string;
  }>;
  mcp: Array<{
    name: string;
    scope: DiagnosticScope;
    transport: 'stdio' | 'http' | 'sse' | 'unknown';
    origin?: string;
    commandName?: string;
    envNames: string[];
    status: 'configured';
  }>;
  skills: Array<{ name: string; scope: DiagnosticScope; path: string }>;
  warnings: string[];
}
