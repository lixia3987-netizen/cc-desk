/** Synchronous Electron safeStorage only. Async storage uses a different proof. */
export interface NativeSafeStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class NativeCredentialStore {
  private readonly memory = new Map<string, string>();
  constructor(private readonly storage?: NativeSafeStorage, private readonly platform: string = process.platform) {}

  protection(): { persistentAvailable: boolean; reason?: string } {
    try {
      if (!this.storage?.isEncryptionAvailable()) return { persistentAvailable: false, reason: '系统安全存储不可用，请使用环境变量或本次内存凭据。' };
      if (this.platform === 'linux') {
        const backend = this.storage.getSelectedStorageBackend?.();
        if (!backend || !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)) {
          return { persistentAvailable: false, reason: '无法确认系统凭据保护（basic_text / unknown 不受支持），请使用环境变量或本次内存凭据。' };
        }
      } else if (this.platform !== 'win32' && this.platform !== 'darwin') {
        return { persistentAvailable: false, reason: '当前系统的凭据保护无法验证，请使用环境变量或本次内存凭据。' };
      }
      return { persistentAvailable: true };
    } catch { return { persistentAvailable: false, reason: '系统安全存储检查失败，请使用环境变量或本次内存凭据。' }; }
  }

  encrypt(secret: string): string {
    this.requireProtection();
    try { return this.storage!.encryptString(secret).toString('base64'); }
    catch { throw new Error('无法安全保存凭据；请使用环境变量或本次内存凭据。'); }
  }

  decrypt(ciphertext: string): string {
    this.requireProtection();
    try { return this.storage!.decryptString(Buffer.from(ciphertext, 'base64')); }
    catch { throw new Error('无法解密此连接的凭据，请重新设置凭据。'); }
  }

  get(id: string): string | undefined { return this.memory.get(id); }
  set(id: string, secret: string): void { this.memory.set(id, secret); }
  delete(id: string): void { this.memory.delete(id); }

  private requireProtection(): void {
    const status = this.protection();
    if (!status.persistentAvailable) throw new Error(status.reason);
  }
}
