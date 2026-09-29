/** Discovery returns metadata; explicit inspection separately returns bounded literal content. */
export interface NativeSkillsListResult {
  entries: Array<{ path: string; name: string; hash: string; bytes: number }>;
  issues: Array<{ path: string; message: string }>;
  truncated: boolean;
}
export interface NativeSkillPreview {
  path: string; name: string; hash: string; bytes: number; content: string;
}
export interface NativeInstructionsPreview {
  targetPath: string;
  digest: string;
  sources: Array<{ path: string; scope: string; hash: string; bytes: number; content: string }>;
}
export interface NativeSkillsAPI {
  list(input: { sessionId: string }): Promise<NativeSkillsListResult>;
  inspect(input: { sessionId: string; path: string }): Promise<NativeSkillPreview>;
  inspectInstructions(input: { sessionId: string; targetPath: string }): Promise<NativeInstructionsPreview>;
}
