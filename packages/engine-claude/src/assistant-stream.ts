import { createHash, randomUUID, type Hash } from 'node:crypto';
import type { ChatMessage } from '@cc-desk/contracts/chat';
import { object, string, type WireObject } from './chat-protocol.js';

interface TextBlock { id: string; index: number; length: number; digest: string; hash?: Hash; finalized?: boolean; envelopeId?: string }
interface AssistantGroup { id: string; sourceId: string; parent?: string; blocks: Map<number, TextBlock>; completed: boolean; stopped?: boolean }
interface AssistantOutput {
  turnId(): string | undefined;
  getMessage(id: string): ChatMessage | undefined;
  message(message: ChatMessage, delta?: string): void;
  context(payload: WireObject): void;
  model(model: string): void;
}
const now = () => new Date().toISOString();

/** Reconciles streamed blocks and complete envelopes without conflating turns or child scopes. */
export class AssistantStream {
  readonly streams = new Map<string, string>();
  readonly assistants = new Map<string, AssistantGroup>();
  latestRoot?: AssistantGroup;
  constructor(private output: AssistantOutput) {}
  reset() { this.streams.clear(); this.assistants.clear(); this.latestRoot = undefined; }
  private groupId(sourceId: string, parent?: string) { return JSON.stringify([this.output.turnId(), parent ?? null, sourceId]); }
  private group(sourceId: string, parent?: string): AssistantGroup {
    const id = this.groupId(sourceId, parent);
    let group = this.assistants.get(id);
    if (!group) { group = { id, sourceId, parent, blocks: new Map(), completed: false }; this.assistants.set(id, group); }
    return group;
  }
  private digest(text: string) { return createHash('sha256').update(text, 'utf16le').digest('hex'); }
  private compatible(block: TextBlock, text: string) {
    return text.length >= block.length && this.digest(text.slice(0, block.length)) === block.digest;
  }
  groupFor(payload: WireObject, frame: WireObject, parent?: string) {
    const sourceId = string(payload.id);
    const envelopeId = string(frame.uuid);
    const knownEnvelope = envelopeId ? this.assistants.get(this.groupId(envelopeId, parent)) : undefined;
    if (knownEnvelope) return knownEnvelope;
    if (sourceId) {
      const group = this.group(sourceId, parent);
      if (envelopeId) this.assistants.set(this.groupId(envelopeId, parent), group);
      return group;
    }
    const streamed = this.assistants.get(this.streams.get(JSON.stringify(parent ?? null)) ?? '');
    const texts = (Array.isArray(payload.content) ? payload.content : []).map(object).filter(block => block.type === 'text');
    // An envelope without an API message id can only reconcile against the
    // pending stream in this exact parent/turn scope.
    if (streamed && !streamed.completed && texts.length && texts.every(block => [...streamed.blocks.values()].some(candidate => this.compatible(candidate, string(block.text))))) {
      if (envelopeId) this.assistants.set(this.groupId(envelopeId, parent), streamed);
      return streamed;
    }
    return this.group(string(frame.uuid) || randomUUID(), parent);
  }
  completeText(group: AssistantGroup, index: number, text: string, used: Set<number>, singleBlock: boolean, envelopeId: string) {
    const indexed = group.blocks.get(index);
    // A completed envelope can contain one block at a time, with indexes relative
    // to that envelope. Match it to the stream's block before trusting the index.
    const digest = this.digest(text);
    const candidates = [...group.blocks.values()].filter(block => !used.has(block.index) && (!block.finalized || !envelopeId || block.envelopeId === envelopeId));
    const exact = (block: TextBlock) => block.length === text.length && block.digest === digest;
    const eligibleIndex = indexed && candidates.includes(indexed) ? indexed : undefined;
    const match = candidates.find(block => !block.finalized && exact(block)) ?? (eligibleIndex && exact(eligibleIndex) ? eligibleIndex : candidates.find(exact))
      ?? (eligibleIndex && this.compatible(eligibleIndex, text) ? eligibleIndex : candidates.find(block => this.compatible(block, text)));
    const blockIndex = match?.index ?? (indexed?.finalized && (singleBlock || envelopeId && indexed.envelopeId !== envelopeId) ? Math.max(...group.blocks.keys()) + 1 : index);
    used.add(blockIndex);
    const messageId = group.id + ':' + blockIndex;
    const existing = this.output.getMessage(messageId);
    if (existing && match?.finalized && match.length === text.length && match.digest === digest && (!envelopeId || existing.sourceId === envelopeId)) return;
    group.blocks.set(blockIndex, { id: messageId, index: blockIndex, length: text.length, digest, finalized: true, envelopeId: envelopeId || undefined });
    this.output.message({ id: messageId, sourceId: envelopeId || group.sourceId, turnId: this.output.turnId()!, role: 'assistant', text, createdAt: existing?.createdAt ?? now(), parentToolUseId: group.parent });
  }
  matchesSummary(summary: string) {
    const group = this.latestRoot;
    if (!group) return false;
    const blocks = [...group.blocks.values()].sort((a, b) => a.index - b.index).filter(block => block.length);
    if (!blocks.length) return false;
    // Result text describes the latest root reply, not a new assistant message.
    // Compare full-content fingerprints, independent of the bounded UI text.
    const last = blocks[blocks.length - 1];
    if (last.length === summary.length && last.digest === this.digest(summary)) return true;
    return ['', '\n', '\n\n'].some(separator => {
      if (blocks.reduce((length, block) => length + block.length, separator.length * (blocks.length - 1)) !== summary.length) return false;
      let offset = 0;
      return blocks.every((block, index) => {
        if (index) { if (summary.slice(offset, offset + separator.length) !== separator) return false; offset += separator.length; }
        const part = summary.slice(offset, offset + block.length); offset += block.length;
        return block.digest === this.digest(part);
      });
    });
  }
  stream(event: WireObject, parent?: string) {
    if (!this.output.turnId()) return;
    const key = JSON.stringify(parent ?? null);
    if (event.type === 'message_start') {
      if (!parent) this.output.context(object(event.message));
      const message = object(event.message); const group = this.group(string(message.id) || randomUUID(), parent);
      this.streams.set(key, group.id);
      if (!parent) { this.latestRoot = group; if (typeof message.model === 'string') { this.output.model(message.model); } }
      return;
    }
    const index = typeof event.index === 'number' ? event.index : 0;
    const group = this.assistants.get(this.streams.get(key) ?? ''); if (!group) return;
    if (event.type === 'message_stop') { group.stopped = true; for (const block of group.blocks.values()) block.hash = undefined; return; }
    if (event.type === 'content_block_stop') { const block = group.blocks.get(index); if (block) block.hash = undefined; return; }
    const content = object(event.content_block); const delta = object(event.delta);
    const messageId = group.id + ':' + index;
    if (event.type === 'content_block_start' && content.type === 'text') {
      const text = string(content.text); const hash = createHash('sha256').update(text, 'utf16le');
      group.completed = false;
      group.blocks.set(index, { id: messageId, index, length: text.length, digest: hash.copy().digest('hex'), hash });
      this.output.message({ id: messageId, sourceId: group.sourceId, turnId: this.output.turnId()!, role: 'assistant', text, createdAt: now(), parentToolUseId: parent });
    } else if (event.type === 'content_block_delta' && delta.type === 'text_delta') {
      const text = string(delta.text);
      const block = group.blocks.get(index) ?? { id: messageId, index, length: 0, digest: this.digest(''), hash: createHash('sha256') };
      if (!block.hash) return;
      block.hash.update(text, 'utf16le'); block.length += text.length; block.digest = block.hash.copy().digest('hex'); group.blocks.set(index, block);
      const existing = this.output.getMessage(messageId);
      this.output.message({ id: messageId, sourceId: group.sourceId, turnId: this.output.turnId()!, role: 'assistant', createdAt: now(), parentToolUseId: parent, ...existing, text: (existing?.text ?? '') + text }, text);
    }
    // Thinking content is not persisted; its events still reset the idle watchdog.
  }
  prune() {
    // Retain a bounded identity window for replayed complete envelopes. Active
    // streams and the root reply needed for result reconciliation stay protected.
    if (this.assistants.size <= 1024) return;
    const active = new Set(this.streams.values());
    for (const [key, group] of this.assistants) {
      if (this.assistants.size <= 1024) break;
      if (group !== this.latestRoot && !active.has(group.id)) this.assistants.delete(key);
    }
  }
}
