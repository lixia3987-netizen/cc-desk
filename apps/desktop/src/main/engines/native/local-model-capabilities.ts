import type { NativeModelCapabilities } from '../../../shared/native-connections';
import type { ResolvedNativeConnection } from './connections';

/** 仅接受精确匹配的官方 API 主机、路径和 ID；代理名称不赋予任何能力。
 * Claude 已于 2026-10-02 验证。
 * Claude: https://platform.claude.com/docs/en/models/overview (Models API 仍是权威依据).
 * 从 4.6 开始，不含日期的 ID 会固定版本： https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions .
 * Kimi 已于 2026-10-07 验证： https://www.kimi.com/code/docs/kimi-code/models.html .
 * K3 的上下文窗口为 1M；k3-256k 为 256K。这是模型规格，并非账户权益：
 * Plus/Moderato 账户仍可能将 k3 限制为 256K；优先采用供应商及目录限制，
 * 模型能力绝不会提高用户配置的预算；最大输出量仍未知。
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
    const context = connection.model === 'k3' ? 1_048_576 : 262_144;
    return { capabilities: { contextWindow: { value: context, source: 'fallback' }, maxInputTokens: { value: context, source: 'fallback' } } };
  }
  return { capabilities: {} };
}
