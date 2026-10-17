import { z } from 'zod';
import type { NativeSessionSkillsSave } from '../../shared/native-skills';
import { NativeSessionSkillSettings, type NativeSessionSkillSettingsHost } from '../engines/native/session-skill-settings';
import type { Register } from './registration';

export function registerNativeSessionSkillHandlers(handle: Register, host: NativeSessionSkillSettingsHost): void {
  const settings = new NativeSessionSkillSettings(host);
  const sessionId = z.string().min(1).max(100);
  handle('native:session-skills', z.object({ sessionId }).strict(), input => settings.get(input.sessionId));
  handle('native:session-skills-save', z.object({ sessionId, mutationId: z.string().uuid(), expectedConfigDigest: z.string().regex(/^[a-f0-9]{64}$/), policy: z.unknown() }).strict(),
    input => settings.save(input as NativeSessionSkillsSave));
}
