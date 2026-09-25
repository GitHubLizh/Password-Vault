import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../server/app.js';

export const ORIGIN = 'http://127.0.0.1:47821';
export const HOST = '127.0.0.1:47821';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string | undefined>;
}

export interface Fixture {
  directory: string;
  storagePath: string;
  now(): number;
  advance(milliseconds: number): void;
  restart(): Promise<void>;
  api(method: Method, path: string, options?: RequestOptions): Promise<LightMyRequestResponse>;
}

// Mirrors the harness in tests/api.test.ts so profile tests exercise the same HTTP seam.
export async function withVault(operation: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'local-vault-profile-test-'));
  let app: ReturnType<typeof buildApp> | undefined;
  let now = Date.UTC(2026, 0, 2, 3, 4, 5);
  const createApp = () => buildApp({ directory, origin: ORIGIN, now: () => now });
  try {
    app = createApp();
    await operation({
      directory,
      storagePath: join(directory, 'vault.pvlt'),
      now: () => now,
      advance(milliseconds) {
        assert.ok(milliseconds >= 0, 'test clock must only move forward');
        now += milliseconds;
      },
      async restart() {
        await app!.close();
        app = createApp();
      },
      async api(method, url, options = {}) {
        const headers: Record<string, string> = { host: HOST, 'x-vault-client': 'local-web' };
        if (method !== 'GET') headers.origin = ORIGIN;
        if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
        if (options.body !== undefined) headers['content-type'] = 'application/json';
        for (const [name, value] of Object.entries(options.headers ?? {})) {
          if (value === undefined) delete headers[name];
          else headers[name] = value;
        }
        return app!.inject({
          method, url, headers,
          ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
        });
      },
    });
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export function success<T>(response: LightMyRequestResponse): T {
  assert.equal(response.statusCode, 200, 'request should succeed');
  assert.match(String(response.headers['cache-control']), /\bno-store\b/);
  return response.json<T>();
}

export function failure(response: LightMyRequestResponse, status: number, code: string): void {
  assert.equal(response.statusCode, status, `request should fail with ${status} ${code}: ${response.body}`);
  assert.match(String(response.headers['cache-control']), /\bno-store\b/);
  assert.equal(response.json<{ code: string }>().code, code);
}
