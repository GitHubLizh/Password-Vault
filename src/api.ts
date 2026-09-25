import type {
  AutoLockMinutes,
  EntryInput,
  RestorePreview,
  SessionResponse,
  StorageLocationResponse,
  VaultResponse,
  VaultStatus,
} from '../shared/types';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// Credentials deliberately live only in the caller's memory, never in browser storage.
async function request<T>(
  path: string,
  options: { method?: string; token?: string; body?: unknown; binary?: boolean; keepalive?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'X-Vault-Client': 'local-web' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
      keepalive: options.keepalive ?? false,
    });
    if (!response.ok) {
      let message = `请求失败（${response.status}），请重试。`;
      let code = 'HTTP_ERROR';
      try {
        const error: unknown = await response.json();
        if (typeof error === 'object' && error !== null) {
          if ('message' in error && typeof error.message === 'string') message = error.message;
          if ('code' in error && typeof error.code === 'string') code = error.code;
        }
      } catch {
        // A proxy or a stopped local service may return a non-JSON error page.
      }
      throw new ApiError(message, response.status, code);
    }
    return (options.binary ? await response.blob() : await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('无法连接本地服务或请求已超时，请检查服务后重试。', 0, 'NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeout);
  }
}

export const api = {
  status: (token?: string) => request<VaultStatus>('/status', { token }),
  vault: (token: string) => request<VaultResponse>('/vault', { token }),
  create: (password: string) => request<SessionResponse>('/create', { method: 'POST', body: { password } }),
  unlock: (password: string) => request<SessionResponse>('/unlock', { method: 'POST', body: { password } }),
  lock: (token: string, keepalive = false) => request<{ ok: true }>('/lock', {
    method: 'POST', token, body: {}, keepalive,
  }),
  activity: (token: string) => request<{ expiresAt: number }>('/activity', { method: 'POST', token, body: {} }),
  save: (token: string, entry: EntryInput, revision: number, id?: string) => request<VaultResponse>(
    id ? `/entries/${encodeURIComponent(id)}` : '/entries',
    { method: id ? 'PUT' : 'POST', token, body: { entry, revision } },
  ),
  remove: (token: string, id: string, revision: number) => request<VaultResponse>(
    `/entries/${encodeURIComponent(id)}`, { method: 'DELETE', token, body: { revision } },
  ),
  settings: (token: string, autoLockMinutes: AutoLockMinutes, revision: number) => request<VaultResponse>(
    '/settings', { method: 'PUT', token, body: { autoLockMinutes, revision } },
  ),
  storageLocation: (token: string, directory: string, storagePath: string, revision: number) => request<StorageLocationResponse>(
    '/storage-location', { method: 'POST', token, body: { directory, storagePath, revision, confirmed: true } },
  ),
  backup: (token: string) => request<Blob>('/backup', { token, binary: true }),
  preview: (backup: string, password: string, token?: string) => request<RestorePreview>(
    '/restore/preview', { method: 'POST', token, body: { backup, password } },
  ),
  confirmRestore: (restoreToken: string, token?: string) => request<SessionResponse>(
    '/restore/confirm', { method: 'POST', token, body: { restoreToken } },
  ),
  cancelRestore: (restoreToken: string, token?: string) => request<{ ok: true }>(
    '/restore/cancel', { method: 'POST', token, body: { restoreToken } },
  ),
};
