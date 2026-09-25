import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const VAULT_FILE = 'vault.pvlt';

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function isVaultFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// A profile exists iff its vault.pvlt is a readable regular file. Unreadable candidates are skipped so
// one broken directory cannot take down the whole listing; a symlinked folder is never a profile.
export async function listProfileIds(root: string): Promise<string[]> {
  const ids: string[] = [];
  if (await isVaultFile(join(root, VAULT_FILE))) ids.push('');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return ids;
    throw error;
  }
  const nested: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await isVaultFile(join(root, entry.name, VAULT_FILE))) nested.push(entry.name);
  }
  nested.sort((left, right) => left.localeCompare(right, 'zh'));
  return [...ids, ...nested];
}
