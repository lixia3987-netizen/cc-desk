/** Native Skills v1 contracts. These types alone do not enable runtime activation. */
export type SkillScope = 'project' | 'user';
export type SkillSourceKind = 'project-agents' | 'project-claude' | 'project-explicit' | 'managed' | 'user-agents' | 'user-claude' | 'custom';
export type SkillMetadataValue = null | boolean | number | string | SkillMetadataValue[] | { [key: string]: SkillMetadataValue };
export interface SkillDiagnostic {
  code: string;
  message: string;
  severity: 'warning' | 'error';
  sourceId?: string;
  path?: string;
}
export interface SkillMetadataResult {
  format: 'standard' | 'legacy' | 'invalid';
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  unknownFields?: Record<string, SkillMetadataValue>;
  autoMatchable: boolean;
  diagnostics: SkillDiagnostic[];
  headerBytes: number;
}
/** Root mappings stay in the trusted host; catalog entries never expose absolute paths. */
export interface SkillDescriptor extends SkillMetadataResult {
  skillId: string;
  sourceId: string;
  scope: SkillScope;
  relativePath: string;
  sourceRevision: number;
  sourceFingerprint: string;
  metadataHash: string;
  bytes: number;
}
export interface SkillCatalogSnapshot {
  schemaVersion: 1;
  revision: string;
  entries: SkillDescriptor[];
  issues: SkillDiagnostic[];
  truncated: boolean;
}
export interface SkillVersionSnapshot {
  skillId: string;
  sourceRevision: number;
  sourceFingerprint: string;
  fullFileHash: string;
  bodyHash: string;
  bytes: number;
  format: SkillMetadataResult['format'];
}
export interface SkillActivation {
  runId: string;
  skillId: string;
  version: SkillVersionSnapshot;
  origin: 'legacy' | 'pinned' | 'explicit' | 'model';
  requestId: string;
  receiptSeq: number;
  activationRevision: number;
  offeredToRequestId?: string;
  confirmedByResponseId?: string;
}
export interface SkillResourceReceipt {
  skillId: string;
  version: SkillVersionSnapshot;
  relativePath: string;
  contentHash: string;
  bytes: number;
  operation: 'read' | 'copy' | 'execute';
}
/** Reserved for the future queue integration; current chat APIs do not accept it. */
export interface NativeSkillSubmission {
  schemaVersion: 1;
  explicitSkillRefs: Array<{ skillId: string; catalogRevision: string; version: SkillVersionSnapshot }>;
  excludedSkillIds: string[];
}
export type NativeSkillPin = { kind: 'legacy'; path: string } | { kind: 'skill'; skillId: string };
export interface NativeSkillPolicy {
  mode: 'legacy' | 'catalog';
  autoActivation: boolean;
  pins: NativeSkillPin[];
  disabledIds: string[];
}
export interface NativeSkillSourceSetting {
  id: string;
  kind: 'managed' | 'user-agents' | 'user-claude' | 'custom';
  enabled: boolean;
  rootPath: string;
  revision: number;
}
export interface NativeSkillsSettings {
  schemaVersion: 1;
  revision: number;
  sources: NativeSkillSourceSetting[];
  /** Host-maintained tombstones prevent deleted source identities from being rebound. */
  retiredSourceIds?: string[];
}
