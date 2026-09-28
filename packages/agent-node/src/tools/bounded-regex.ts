import { Worker } from 'node:worker_threads';

export interface RegexLineMatch { line: number; column: number; text: string; textStartColumn: number; textTruncated: boolean }
export class BoundedRegexError extends Error {
  constructor(readonly code: 'invalid_regex' | 'regex_timeout' | 'regex_worker_failed' | 'search_cancelled', message: string) { super(message); this.name = 'BoundedRegexError'; }
}
// Fixed source survives CJS/ASAR bundling. User input is data, never executable worker source.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
let expression;
try { expression = new RegExp(workerData.pattern, workerData.caseSensitive ? 'u' : 'iu'); }
catch { parentPort.postMessage({ type: 'invalid' }); }
if (expression) {
  parentPort.postMessage({ type: 'ready' });
  parentPort.on('message', ({ id, text, limit }) => {
    const matches = []; let offset = 0, line = 1, limited = false;
    while (offset <= text.length) {
      const newline = text.indexOf('\n', offset);
      const end = newline < 0 ? text.length : newline;
      const value = text.slice(offset, end);
      const hit = expression.exec(value);
      if (hit) { const start = Math.max(0, hit.index - 160); matches.push({ line, column: hit.index + 1, text: value.slice(start, start + 512), textStartColumn: start + 1, textTruncated: start > 0 || value.length > start + 512 }); }
      if (matches.length >= limit && newline >= 0) { limited = true; break; }
      if (newline < 0) break;
      offset = newline + 1; line++;
    }
    parentPort.postMessage({ type: 'result', id, matches, limited });
  });
}
`;

/** One bounded worker per search, reused across files and always joined on termination. */
export class BoundedRegex {
  private readonly worker: Worker;
  private sequence = 0;
  private death?: Error;
  private stopping?: Promise<number>;
  private busy = false;
  private constructor(pattern: string, caseSensitive: boolean) {
    this.worker = new Worker(WORKER_SOURCE, { eval: true, execArgv: [], env: {}, workerData: { pattern, caseSensitive },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
    this.worker.on('error', error => { this.death = error; });
    this.worker.on('exit', () => { this.death ??= new Error('Regex worker exited'); });
  }
  static async create(pattern: string, caseSensitive: boolean, timeoutMs: number, signal?: AbortSignal): Promise<BoundedRegex> {
    const matcher = new BoundedRegex(pattern, caseSensitive);
    try { await matcher.reply(undefined, 'ready', timeoutMs, signal); return matcher; }
    catch (error) { await matcher.close(); throw error; }
  }
  private async reply(message: unknown, expected: 'ready' | number, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.death || this.stopping || this.busy) throw new BoundedRegexError('regex_worker_failed', 'Regex worker is not available');
    this.busy = true;
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: unknown) => {
          if (settled) return; settled = true;
          clearTimeout(timer); signal?.removeEventListener('abort', aborted);
          this.worker.off('message', received); this.worker.off('error', failed); this.worker.off('exit', exited);
          if (error) void this.close().then(() => reject(error), () => reject(error)); else resolve(value);
        };
        const received = (value: { type?: string; id?: number }) => {
          if (value?.type === 'invalid') finish(new BoundedRegexError('invalid_regex', 'Invalid regular expression'));
          else if (expected === 'ready' && value?.type === 'ready' || typeof expected === 'number' && value?.type === 'result' && value.id === expected) finish(undefined, value);
        };
        const failed = () => finish(new BoundedRegexError('regex_worker_failed', 'Regex worker exceeded resources or failed'));
        const exited = () => finish(new BoundedRegexError('regex_worker_failed', 'Regex worker exited before completing the request'));
        const aborted = () => finish(new BoundedRegexError('search_cancelled', 'Search cancelled'));
        const timer = setTimeout(() => finish(new BoundedRegexError('regex_timeout', 'Regular expression exceeded its execution deadline')), Math.max(1, timeoutMs));
        this.worker.on('message', received); this.worker.on('error', failed); this.worker.on('exit', exited);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
        else if (message !== undefined) this.worker.postMessage(message);
      });
    } finally { this.busy = false; }
  }
  async match(text: string, limit: number, timeoutMs: number, signal?: AbortSignal): Promise<{ matches: RegexLineMatch[]; limited: boolean }> {
    const id = ++this.sequence;
    return await this.reply({ id, text, limit }, id, timeoutMs, signal) as { matches: RegexLineMatch[]; limited: boolean };
  }
  async close(): Promise<void> { this.stopping ??= this.worker.terminate(); await this.stopping; }
}
