/** 发现操作返回元数据，明确检查时才另行返回受限的字面内容。 */
import type { NativeSkillsSettings, NativeSkillSourceSetting, SkillCatalogSnapshot, SkillVersionSnapshot, NativeSkillPin, NativeSkillPolicy } from '@cc-desk/contracts/native-skills';
import type { EngineConfig } from './execution';

export interface NativeSkillsSettingsView { settings: NativeSkillsSettings; runtimeEnabled: false; error?: string }
export interface NativeSkillsSettingsMutation { expectedRevision: number; sources: NativeSkillSourceSetting[] }
export interface NativeSkillMigrationPreview {
  runtimeEnabled: false;
  original: EngineConfig;
  proposed: EngineConfig;
  legacyPins: Array<Extract<NativeSkillPin, { kind: 'legacy' }>>;
}
export interface NativeSkillsCatalogResult extends SkillCatalogSnapshot { runtimeEnabled: false }
export interface NativeCatalogSkillPreview { version: SkillVersionSnapshot; content: string; body: string }
export interface NativeSkillsListResult {
  entries: Array<{ path: string; name: string; hash: string; bytes: number }>;
  issues: Array<{ path: string; message: string }>;
  truncated: boolean;
}
export interface NativeSkillPreview {
  path: string; name: string; hash: string; bytes: number; content: string;
}
export interface NativeSessionSkillsView {
  schemaVersion: 1 | 2;
  configDigest: string;
  policy: NativeSkillPolicy;
  pinDiagnostics: Array<{ path: string; status: 'available' | 'unavailable' | 'unverified'; message?: string }>;
  /** Catalog activation remains gated; legacy guides retain their existing runtime. */
  runtimeEnabled: false;
}
export interface NativeSessionSkillsSave {
  sessionId: string;
  /** Frozen for retries; a new explicit save gets a new identity. */
  mutationId: string;
  expectedConfigDigest: string;
  policy: NativeSkillPolicy;
}
export interface NativeSessionSkillsSaved extends NativeSessionSkillsView {
  config: EngineConfig;
  migrated: boolean;
  backupCreated: boolean;
}
export interface NativeInstructionsPreview {
  targetPath: string;
  digest: string;
  sources: Array<{ path: string; scope: string; hash: string; bytes: number; content: string }>;
}
export interface NativeSkillsAPI {
  settings(): Promise<NativeSkillsSettingsView>;
  saveSettings(input: NativeSkillsSettingsMutation): Promise<NativeSkillsSettingsView>;
  catalog(input: { sessionId: string; refresh?: boolean }): Promise<NativeSkillsCatalogResult>;
  inspectCatalog(input: { sessionId: string; skillId: string; catalogRevision: string }): Promise<NativeCatalogSkillPreview>;
  previewMigration(input: { sessionId: string }): Promise<NativeSkillMigrationPreview>;
  getSessionSkills(input: { sessionId: string }): Promise<NativeSessionSkillsView>;
  saveSessionSkills(input: NativeSessionSkillsSave): Promise<NativeSessionSkillsSaved>;
  list(input: { sessionId: string }): Promise<NativeSkillsListResult>;
  inspect(input: { sessionId: string; path: string }): Promise<NativeSkillPreview>;
  inspectInstructions(input: { sessionId: string; targetPath: string }): Promise<NativeInstructionsPreview>;
}
