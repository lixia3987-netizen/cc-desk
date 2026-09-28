/** Only bounded project-relative metadata crosses IPC, never Skill content. */
export interface NativeSkillsListResult {
  entries: Array<{ path: string; name: string; hash: string; bytes: number }>;
  issues: Array<{ path: string; message: string }>;
  truncated: boolean;
}
export interface NativeSkillsAPI {
  list(input: { sessionId: string }): Promise<NativeSkillsListResult>;
}
