declare module 'js-yaml' {
  export const JSON_SCHEMA: unknown;
  export function load(input: string, options?: {
    schema?: unknown;
    json?: boolean;
    maxDepth?: number;
    maxTotalMergeKeys?: number;
    onWarning?: (warning: unknown) => void;
    listener?: (event: 'open' | 'close', state: { kind?: string; result?: unknown; tag?: string | null; anchor?: string | null; position?: number }) => void;
  }): unknown;
}
