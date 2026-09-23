export type CLIUpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'confirming' | 'disconnecting' | 'updating' | 'updated' | 'error';
export interface CLIUpdateState {
  phase: CLIUpdatePhase;
  currentVersion?: string;
  latestVersion?: string;
  channel?: 'latest' | 'stable';
  message: string;
  checkedAt?: string;
  showBanner: boolean;
}
export const cliUpdateBusy = (state: CLIUpdateState) => ['confirming', 'disconnecting', 'updating'].includes(state.phase);
