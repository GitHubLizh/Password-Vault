export type EntryType = 'account' | 'server' | 'api';
export type AutoLockMinutes = 1 | 5 | 15;

export interface EntryInput {
  type: EntryType;
  name: string;
  username: string;
  address: string;
  port: string;
  password: string;
  apiKey: string;
  secret: string;
  notes: string;
}

export interface VaultEntry extends EntryInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface VaultSnapshot {
  entries: VaultEntry[];
  settings: { autoLockMinutes: AutoLockMinutes };
  revision: number;
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  storagePath: string;
  autoLockMinutes: AutoLockMinutes;
  expiresAt: number | null;
  revision: number | null;
}

export interface VaultResponse {
  vault: VaultSnapshot;
  expiresAt: number;
}

export interface StorageLocationResponse {
  status: VaultStatus;
  previousStoragePath: string;
}

export interface SessionResponse extends VaultResponse {
  token: string;
  safetyBackupPath?: string;
}

export interface RestorePreview {
  restoreToken: string;
  entryCount: number;
  willReplace: boolean;
  expiresAt: number;
}

export interface ApiErrorBody {
  message: string;
  code: string;
}
