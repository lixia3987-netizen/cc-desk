import type { Session } from '../../shared/types';

export type Perform = (action: () => Promise<unknown>) => Promise<void>;
export type ReportError = (error: unknown) => void;
export type OpenNew = (kind?: Session['kind'], fork?: Session, projectId?: string) => void;
