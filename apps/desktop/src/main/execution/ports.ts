import type { ExecutionCapabilities, ExecutionMode, SessionExecution, EngineConfig, EngineConfiguration } from '../../shared/execution';
import type { Session } from '../../shared/types';
import type { StructuredExecutor, TerminalExecutor } from '@cc-desk/contracts/execution-ports';
export type { ExecutionLifecycle, ExecutionSubmission, SessionExport, StructuredExecutor, TerminalExecutor } from '@cc-desk/contracts/execution-ports';

interface RegistrationBase {
  providerId: string;
  displayName?: string;
  configuration?(): EngineConfiguration;
  validateConfig?(config: EngineConfig): EngineConfig;
  history?: boolean;
  defaultWorkflowError?(session: Session): string | undefined;
  capabilities(): ExecutionCapabilities;
  /** 提供方专属身份校验由对应适配器负责。 */
  validateSession?(session: Session): void;
  createIdentity?(input: { conversationId?: string; fork?: boolean }): SessionExecution;
}
export type ExecutionRegistration = RegistrationBase & (
  | { mode: Extract<ExecutionMode, 'structured'>; executor: StructuredExecutor }
  | { mode: Extract<ExecutionMode, 'terminal'>; executor: TerminalExecutor }
);
