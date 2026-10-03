import type { NativeModelCapabilities } from '../../../shared/native-connections';
import type { ResolvedNativeConnection } from './connections';

/** Verified 2026-10-02. Exact official API hosts, paths and IDs only; proxy names confer no capability.
 * Claude: https://platform.claude.com/docs/en/models/overview (Models API remains authoritative).
 * Dateless IDs from 4.6 onward are pinned: https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions .
 * Kimi: https://www.kimi.com/code/docs/kimi-code/models.html . K3 Plus accounts may have only 256K;
 * the fallback deliberately uses that conservative account ceiling, never the advertised 1M entitlement.
 */
const claude: Readonly<Record<string, { context: number; output: number }>> = Object.freeze({
  'claude-fable-5-1': { context: 1_000_000, output: 128_000 },
  'claude-opus-5-5': { context: 1_000_000, output: 128_000 },
  'claude-sonnet-5-5': { context: 1_000_000, output: 128_000 },
  'claude-haiku-4-5-20251001': { context: 200_000, output: 64_000 },
});
export function localNativeModelCapabilities(connection: Pick<ResolvedNativeConnection, 'protocol' | 'baseURL' | 'model'>): { capabilities: NativeModelCapabilities; conservative?: boolean } {
  let url: URL; try { url = new URL(connection.baseURL); } catch { return { capabilities: {} }; }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (url.protocol !== 'https:' || url.port || url.search || url.hash || url.username || url.password) return { capabilities: {} };
  if (connection.protocol === 'anthropic' && url.hostname === 'api.anthropic.com' && ['', '/v1', '/v1/messages'].includes(pathname)) {
    const found = Object.hasOwn(claude, connection.model) ? claude[connection.model] : undefined;
    if (found) return { capabilities: { contextWindow: { value: found.context, source: 'fallback' }, maxInputTokens: { value: found.context, source: 'fallback' }, maxOutputTokens: { value: found.output, source: 'fallback' } } };
  }
  if (['anthropic', 'chat-completions'].includes(connection.protocol) && ['api.kimi.com', 'api.kimi.ai'].includes(url.hostname) && ['/coding', '/coding/v1', '/coding/v1/messages'].includes(pathname)
    && ['k3', 'k3-256k'].includes(connection.model)) {
    return { capabilities: { contextWindow: { value: 262_144, source: 'fallback' }, maxInputTokens: { value: 262_144, source: 'fallback' } }, conservative: true };
  }
  return { capabilities: {} };
}
