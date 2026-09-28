declare module 'node-pty/lib/utils' {
  export function loadNativeModule(name: string): { dir: string; module: { ccDeskConptyFix?: unknown } };
}
