import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import type { VaultSnapshot } from '../shared/types.js';
import { VaultError } from './errors.js';
import { record, snapshot } from './validation.js';

export const MAX_VAULT_BYTES = 8 * 1024 * 1024;
const KDF = { name: 'scrypt', N: 131072, r: 8, p: 1 } as const;

export interface Envelope {
  format: 'local-password-vault';
  version: 1;
  kdf: typeof KDF;
  salt: string;
  cipher: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

function base64(value: unknown, bytes?: number): Buffer {
  if (typeof value !== 'string' || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    throw new Error('Invalid encoding');
  }
  const result = Buffer.from(value, 'base64');
  if (!result.length || (bytes !== undefined && result.length !== bytes) || result.toString('base64') !== value) {
    throw new Error('Invalid length');
  }
  return result;
}

export function parseEnvelope(source: string): Envelope {
  try {
    if (Buffer.byteLength(source) > MAX_VAULT_BYTES) throw new Error('File too large');
    const value = record(JSON.parse(source));
    const kdf = record(value.kdf);
    if (value.format !== 'local-password-vault' || value.version !== 1 || value.cipher !== 'aes-256-gcm'
      || kdf.name !== KDF.name || kdf.N !== KDF.N || kdf.r !== KDF.r || kdf.p !== KDF.p) {
      throw new Error('Unsupported format');
    }
    base64(value.salt, 16);
    base64(value.iv, 12);
    base64(value.tag, 16);
    base64(value.ciphertext);
    return {
      format: 'local-password-vault', version: 1, kdf: KDF,
      salt: value.salt as string, cipher: 'aes-256-gcm', iv: value.iv as string,
      tag: value.tag as string, ciphertext: value.ciphertext as string,
    };
  } catch {
    throw new VaultError(400, 'INVALID_VAULT', '文件不是受支持的加密备份，或文件已经损坏。');
  }
}

export function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 256 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function header(salt: string): Buffer {
  return Buffer.from(JSON.stringify({ format: 'local-password-vault', version: 1, kdf: KDF, salt, cipher: 'aes-256-gcm' }));
}

export function encrypt(data: VaultSnapshot, key: Buffer, salt: Buffer): string {
  const iv = randomBytes(12);
  const saltText = salt.toString('base64');
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(header(saltText));
  const plaintext = Buffer.from(JSON.stringify(data));
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: Envelope = {
      format: 'local-password-vault', version: 1, kdf: KDF, salt: saltText,
      cipher: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    const output = JSON.stringify(envelope);
    if (Buffer.byteLength(output) > MAX_VAULT_BYTES) {
      throw new VaultError(400, 'VAULT_TOO_LARGE', '密码库已达到 8 MiB 上限，请减少条目或备注长度。');
    }
    return output;
  } finally {
    plaintext.fill(0);
  }
}

export function decrypt(envelope: Envelope, key: Buffer): VaultSnapshot {
  let plaintext: Buffer | undefined;
  let first: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(header(envelope.salt));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    first = decipher.update(Buffer.from(envelope.ciphertext, 'base64'));
    plaintext = Buffer.concat([first, decipher.final()]);
    return snapshot(JSON.parse(plaintext.toString('utf8')));
  } catch {
    throw new VaultError(400, 'DECRYPT_FAILED', '主密码不正确，或密码库文件已损坏。');
  } finally {
    first?.fill(0);
    plaintext?.fill(0);
  }
}
