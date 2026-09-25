import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { VaultError } from './errors.js';
import { profileName } from './profile-name.js';

export const DEFAULT_PROFILE_NAME = '默认';

// The display name is app-side metadata, not part of the encrypted store: a corrupt or missing file
// must never block unlocking, so every failure path falls back to the built-in name.
export async function readDefaultProfileName(configPath: string): Promise<string> {
  let source: string;
  try {
    source = await readFile(configPath, 'utf8');
  } catch {
    return DEFAULT_PROFILE_NAME;
  }
  try {
    const value = JSON.parse(source) as { version?: unknown; defaultName?: unknown };
    if (!value || value.version !== 1 || typeof value.defaultName !== 'string') return DEFAULT_PROFILE_NAME;
    return value.defaultName === DEFAULT_PROFILE_NAME ? DEFAULT_PROFILE_NAME : profileName(value.defaultName);
  } catch {
    return DEFAULT_PROFILE_NAME;
  }
}

export async function writeDefaultProfileName(configPath: string, raw: unknown): Promise<string> {
  const name = profileName(raw);
  // tmp + rename only: unlike the storage-location pointer, a torn write here costs nothing but a
  // display name, so it must not be able to fail the request with FILE_BUSY.
  const temporaryPath = join(dirname(configPath), `.profiles-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, defaultName: name }), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, configPath);
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    throw new VaultError(500, 'STORAGE_ERROR', '身份档名称保存失败，原名称仍在使用。请检查目录权限后重试。');
  }
  return name;
}
