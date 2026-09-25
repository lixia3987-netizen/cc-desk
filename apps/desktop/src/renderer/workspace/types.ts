import type { NewSession, Session } from '../../shared/types';
import type { EngineConfig } from '../../shared/execution';

export type SessionDraft = NewSession & { engineConfig: EngineConfig };

export type Perform = (action: () => Promise<unknown>) => Promise<void>;
export type ReportError = (error: unknown) => void;
export type OpenNew = (kind?: Session['kind'], fork?: Session, projectId?: string) => void;
