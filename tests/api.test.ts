import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../server/app.js';
import { parseEnvelope } from '../server/crypto.js';
import type { EntryInput, RestorePreview, SessionResponse, VaultResponse, VaultStatus } from '../shared/types.js';

const ORIGIN = 'http://127.0.0.1:47821';
const HOST = '127.0.0.1:47821';
const PASSWORD = '  本地测试-主密码-e\u0301  ';
const WRONG_PASSWORD = '  不匹配的测试主密码  ';
const HTML_NOTES = '<script>globalThis.__vaultNotesExecuted = true</script><img src=x onerror="alert(1)">';
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
interface RequestOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string | undefined>;
}
interface Fixture {
  directory: string;
  storagePath: string;
  now(): number;
  advance(milliseconds: number): void;
  restart(): Promise<void>;
  api(method: Method, path: string, options?: RequestOptions): Promise<LightMyRequestResponse>;
}

async function withVault(operation: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'local-vault-api-test-'));
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

function noStore(response: LightMyRequestResponse): void {
  assert.match(String(response.headers['cache-control']), /\bno-store\b/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
}

function success<T = VaultResponse>(response: LightMyRequestResponse): T {
  assert.equal(response.statusCode, 200, 'request should succeed');
  noStore(response);
  return response.json<T>();
}

function failure(response: LightMyRequestResponse, status: number, code: string): void {
  assert.equal(response.statusCode, status, 'request should be rejected with the expected status');
  noStore(response);
  const body = response.json<{ code: string; message: string }>();
  assert.equal(body.code, code);
  assert.deepEqual(Object.keys(body).sort(), ['code', 'message']);
  assert.equal(typeof body.message, 'string');
}

function same(actual: unknown, expected: unknown, message: string): void {
  // Boolean assertions avoid printing secrets or session tokens in failure diagnostics.
  assert.ok(isDeepStrictEqual(actual, expected), message);
}

function wrongToken(token: string): string {
  return `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`;
}

function entry(type: EntryInput['type'], name = `不应出现在密文的-${type}`): EntryInput {
  return {
    type, name, username: '  测试用户-e\u0301  ', address: 'https://example.invalid/路径',
    port: type === 'server' ? '65535' : '',
    password: type === 'api' ? '' : '  凭据-秘密-e\u0301\t\n  ',
    apiKey: type === 'api' ? '  API-测试密钥-e\u0301  ' : '',
    secret: type === 'api' ? '\t API-私密-secret \n' : '',
    notes: HTML_NOTES,
  };
}

async function create(fixture: Fixture): Promise<SessionResponse> {
  const result = success<SessionResponse>(await fixture.api('POST', '/api/create', { body: { password: PASSWORD } }));
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(result.token), 'create must return an opaque session token');
  assert.equal(result.vault.revision, 1);
  assert.deepEqual(result.vault.entries, []);
  assert.equal(result.expiresAt, fixture.now() + 5 * 60000);
  return result;
}

async function unchanged(fixture: Fixture, token: string, before: VaultResponse, source: string): Promise<void> {
  same(await readFile(fixture.storagePath, 'utf8'), source, 'failed operation must not change bytes on disk');
  same(success(await fixture.api('GET', '/api/vault', { token })), before, 'failed operation must not mutate the in-memory vault or expiry');
}

test('empty vault, local-request boundaries and unauthenticated access', async t => {
  await withVault(async fixture => {
    const { api } = fixture;
    await t.test('missing vault status is metadata only, uncached and does not create files', async () => {
      const response = await api('GET', '/api/status');
      assert.deepEqual(success<VaultStatus>(response), {
        exists: false, unlocked: false, storagePath: fixture.storagePath,
        autoLockMinutes: 5, expiresAt: null, revision: null,
      });
      assert.equal(response.headers['x-frame-options'], 'DENY');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
      assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
      assert.deepEqual(await readdir(fixture.directory), []);
    });

    await t.test('missing client, foreign/null origins, wrong hosts and cross-site requests get 403', async () => {
      const denied: Array<[Record<string, string | undefined>, string]> = [
        [{ 'x-vault-client': undefined }, 'FORBIDDEN_CLIENT'],
        [{ 'x-vault-client': 'other-client' }, 'FORBIDDEN_CLIENT'],
        [{ origin: 'https://attacker.invalid' }, 'FORBIDDEN_ORIGIN'],
        [{ origin: 'null' }, 'FORBIDDEN_ORIGIN'],
        [{ origin: 'http://127.0.0.1:47822' }, 'FORBIDDEN_ORIGIN'],
        [{ host: 'attacker.invalid:47821' }, 'FORBIDDEN_HOST'],
        [{ host: '127.0.0.1:47822' }, 'FORBIDDEN_HOST'],
        [{ host: 'localhost:47821' }, 'FORBIDDEN_HOST'],
        [{ 'sec-fetch-site': 'cross-site' }, 'FORBIDDEN_CLIENT'],
        [{ 'sec-fetch-site': 'same-site' }, 'FORBIDDEN_CLIENT'],
      ];
      for (const [headers, code] of denied) {
        failure(await api('GET', '/api/status', { headers }), 403, code);
        failure(await api('POST', '/api/create', { headers, body: { password: PASSWORD } }), 403, code);
      }
      for (const site of ['same-origin', 'none']) {
        success<VaultStatus>(await api('GET', '/api/status', { headers: { 'sec-fetch-site': site } }));
      }
      assert.deepEqual(await readdir(fixture.directory), []);
    });

    await t.test('all protected read/write endpoints require a session', async () => {
      const routes: Array<[Method, string, unknown?]> = [
        ['GET', '/api/vault'], ['GET', '/api/backup'], ['POST', '/api/lock'], ['POST', '/api/activity'],
        ['POST', '/api/entries', { revision: 1, entry: entry('account') }],
        ['PUT', '/api/entries/missing', { revision: 1, entry: entry('server') }],
        ['DELETE', '/api/entries/missing', { revision: 1 }],
        ['PUT', '/api/settings', { revision: 1, autoLockMinutes: 1 }],
      ];
      for (const [method, path, body] of routes) failure(await api(method, path, { body }), 401, 'LOCKED');
    });

    await t.test('short master passwords and null API bodies are rejected without creating a vault', async () => {
      for (const body of [null, [], {}, { password: null }, { password: 123456789012 }, { password: '' }, { password: 'x'.repeat(11) }]) {
        failure(await api('POST', '/api/create', { body }), 400, 'INVALID_INPUT');
      }
      failure(await api('POST', '/api/unlock', { body: { password: PASSWORD } }), 404, 'NOT_FOUND');
      assert.deepEqual(await readdir(fixture.directory), []);
    });
  });
});

test('create, three credential types, validation, locking and disk persistence', async t => {
  await withVault(async fixture => {
    const { api } = fixture;
    const created = await create(fixture);
    let token = created.token;
    let state: VaultResponse = { vault: created.vault, expiresAt: created.expiresAt };

    await t.test('duplicate creation is refused and a fresh client cannot inherit a live session', async () => {
      const source = await readFile(fixture.storagePath, 'utf8');
      fixture.advance(1000);
      failure(await api('POST', '/api/create', { body: { password: PASSWORD } }), 409, 'EXISTS');
      const anonymous = success<VaultStatus>(await api('GET', '/api/status'));
      assert.equal(anonymous.exists, true);
      assert.equal(anonymous.unlocked, false);
      assert.equal(anonymous.revision, null);
      assert.equal(anonymous.expiresAt, null);
      failure(await api('GET', '/api/vault'), 401, 'LOCKED');
      for (const authorization of [token, `Basic ${token}`, 'Bearer ', `Bearer ${wrongToken(token)}`, `Bearer ${token.slice(1)}`]) {
        failure(await api('GET', '/api/vault', { headers: { authorization } }), 401, 'LOCKED');
      }
      const authenticated = success<VaultStatus>(await api('GET', '/api/status', { token }));
      assert.equal(authenticated.unlocked, true);
      assert.equal(authenticated.revision, 1);
      await unchanged(fixture, token, state, source);
    });

    await t.test('account, server and API credentials create/read/update exactly and notes remain JSON text', async () => {
      for (const type of ['account', 'server', 'api'] as const) {
        const input = entry(type);
        const revision = state.vault.revision;
        state = success(await api('POST', '/api/entries', { token, body: { revision, entry: input } }));
        assert.equal(state.vault.revision, revision + 1);
        const saved = state.vault.entries.at(-1)!;
        assert.match(saved.id, /^[a-f0-9-]{36}$/i);
        same(saved, { ...input, id: saved.id, createdAt: new Date(fixture.now()).toISOString(), updatedAt: new Date(fixture.now()).toISOString() }, 'created entry must preserve all input fields');
        const read = await api('GET', '/api/vault', { token });
        assert.match(String(read.headers['content-type']), /^application\/json\b/);
        assert.match(String(read.headers['content-security-policy']), /script-src 'self'/);
        same(success(read), state, 'GET must return the saved snapshot as JSON, including literal HTML notes');
        fixture.advance(1000);
        const updated = { ...input, name: `${input.name}-已更新`, notes: `${HTML_NOTES}\n  保留备注空格  ` };
        state = success(await api('PUT', `/api/entries/${saved.id}`, { token, body: { revision: state.vault.revision, entry: updated } }));
        const changed = state.vault.entries.find(item => item.id === saved.id)!;
        same(changed, { ...updated, id: saved.id, createdAt: saved.createdAt, updatedAt: new Date(fixture.now()).toISOString() }, 'update must preserve secrets, ID and creation time');
      }
      assert.equal(state.vault.entries.length, 3);
      assert.equal(new Set(state.vault.entries.map(item => item.id)).size, 3);
    });

    await t.test('invalid ports, empty API credentials, null fields and bad revisions never mutate data', async () => {
      const source = await readFile(fixture.storagePath, 'utf8');
      const invalidEntries: unknown[] = [
        null, [], { ...entry('api'), apiKey: '', secret: '' },
        { ...entry('account'), username: '', password: '' },
        { ...entry('account'), name: '   ' }, { ...entry('account'), type: 'unknown' },
      ];
      for (const port of ['0', '65536', '-1', '1.5', 'abc', ' 22 ', null, 22]) {
        invalidEntries.push({ ...entry('server'), port });
      }
      for (const field of Object.keys(entry('account'))) invalidEntries.push({ ...entry('account'), [field]: null });
      for (const invalid of invalidEntries) {
        failure(await api('POST', '/api/entries', { token, body: { revision: state.vault.revision, entry: invalid } }), 400, 'INVALID_INPUT');
      }
      for (const revision of [null, 0, -1, 1.5, String(state.vault.revision), Number.MAX_SAFE_INTEGER + 1]) {
        failure(await api('POST', '/api/entries', { token, body: { revision, entry: entry('account') } }), 400, 'INVALID_INPUT');
      }
      for (const [method, path] of [
        ['POST', '/api/entries'], ['PUT', `/api/entries/${state.vault.entries[0].id}`],
        ['DELETE', `/api/entries/${state.vault.entries[0].id}`], ['PUT', '/api/settings'],
        ['POST', '/api/restore/preview'], ['POST', '/api/restore/confirm'], ['POST', '/api/restore/cancel'],
      ] as const) failure(await api(method, path, { token, body: null }), 400, 'INVALID_INPUT');
      for (const autoLockMinutes of [null, 0, 2, '5']) {
        failure(await api('PUT', '/api/settings', { token, body: { revision: state.vault.revision, autoLockMinutes } }), 400, 'INVALID_INPUT');
      }
      await unchanged(fixture, token, state, source);
    });

    await t.test('stale revisions and missing IDs cannot overwrite current entries or settings', async () => {
      const source = await readFile(fixture.storagePath, 'utf8');
      const stale = state.vault.revision - 1;
      const path = `/api/entries/${state.vault.entries[0].id}`;
      failure(await api('POST', '/api/entries', { token, body: { revision: stale, entry: entry('account') } }), 409, 'REVISION_CONFLICT');
      failure(await api('PUT', path, { token, body: { revision: stale, entry: entry('account') } }), 409, 'REVISION_CONFLICT');
      failure(await api('DELETE', path, { token, body: { revision: stale } }), 409, 'REVISION_CONFLICT');
      failure(await api('PUT', '/api/settings', { token, body: { revision: stale, autoLockMinutes: 1 } }), 409, 'REVISION_CONFLICT');
      failure(await api('PUT', '/api/entries/absent', { token, body: { revision: state.vault.revision, entry: entry('server') } }), 404, 'NOT_FOUND');
      failure(await api('DELETE', '/api/entries/absent', { token, body: { revision: state.vault.revision } }), 404, 'NOT_FOUND');
      await unchanged(fixture, token, state, source);
    });

    await t.test('persisted envelopes contain no plaintext names, passwords, keys or notes', async () => {
      const source = await readFile(fixture.storagePath, 'utf8');
      assert.equal(parseEnvelope(source).cipher, 'aes-256-gcm');
      const confidential = [PASSWORD, ...state.vault.entries.flatMap(item => [item.name, item.password, item.apiKey, item.secret, item.notes]).filter(Boolean)];
      for (const text of confidential) assert.ok(!source.includes(text), 'disk must contain only encrypted secrets');
      assert.deepEqual(await readdir(fixture.directory), ['vault.pvlt']);
    });

    await t.test('lock invalidates tokens, wrong password is rejected, and injected time bypasses only the throttle', async () => {
      const originalToken = token;
      const source = await readFile(fixture.storagePath, 'utf8');
      failure(await api('POST', '/api/lock', { token: wrongToken(token) }), 401, 'LOCKED');
      await unchanged(fixture, token, state, source);
      same(success(await api('POST', '/api/lock', { token })), { ok: true }, 'lock should succeed');
      failure(await api('GET', '/api/vault', { token }), 401, 'LOCKED');
      failure(await api('POST', '/api/activity', { token }), 401, 'LOCKED');
      failure(await api('GET', '/api/backup', { token }), 401, 'LOCKED');
      failure(await api('POST', '/api/unlock', { body: { password: WRONG_PASSWORD } }), 400, 'DECRYPT_FAILED');
      const throttled = await api('POST', '/api/unlock', { body: { password: PASSWORD } });
      failure(throttled, 429, 'TRY_LATER');
      assert.equal(throttled.headers['retry-after'], '1');
      fixture.advance(1000);
      const unlocked = success<SessionResponse>(await api('POST', '/api/unlock', { body: { password: PASSWORD } }));
      assert.ok(unlocked.token !== originalToken, 'unlock must rotate the session token');
      same(unlocked.vault, state.vault, 'unlock must recover the complete persisted vault');
      token = unlocked.token;
      state = { vault: unlocked.vault, expiresAt: unlocked.expiresAt };
      failure(await api('GET', '/api/vault', { token: originalToken }), 401, 'LOCKED');
      failure(await api('GET', '/api/vault'), 401, 'LOCKED');
      assert.equal(success<VaultStatus>(await api('GET', '/api/status')).unlocked, false);
      await unchanged(fixture, token, state, source);
    });

    await t.test('app restart starts locked, unlock reloads disk, and all three types can be deleted', async () => {
      const previousToken = token;
      await fixture.restart();
      const status = success<VaultStatus>(await api('GET', '/api/status', { token: previousToken }));
      assert.equal(status.exists, true);
      assert.equal(status.unlocked, false);
      failure(await api('GET', '/api/vault', { token: previousToken }), 401, 'LOCKED');
      const unlocked = success<SessionResponse>(await api('POST', '/api/unlock', { body: { password: PASSWORD } }));
      same(unlocked.vault, state.vault, 'restart must retain Unicode secrets and all persisted entries');
      token = unlocked.token;
      state = { vault: unlocked.vault, expiresAt: unlocked.expiresAt };
      for (const saved of [...state.vault.entries]) {
        const revision = state.vault.revision;
        state = success(await api('DELETE', `/api/entries/${saved.id}`, { token, body: { revision } }));
        assert.equal(state.vault.revision, revision + 1);
        assert.ok(!state.vault.entries.some(item => item.id === saved.id));
        same(success(await api('GET', '/api/vault', { token })), state, 'deletion must be visible to readers');
        failure(await api('DELETE', `/api/entries/${saved.id}`, { token, body: { revision: state.vault.revision } }), 404, 'NOT_FOUND');
      }
      assert.deepEqual(state.vault.entries, []);
    });
  });
});

test('activity extends expiry, but status polling cannot prevent automatic locking', async t => {
  await withVault(async fixture => {
    const { api } = fixture;
    const created = await create(fixture);
    let token = created.token;
    let state = success(await api('PUT', '/api/settings', { token, body: { revision: created.vault.revision, autoLockMinutes: 1 } }));
    assert.equal(state.vault.settings.autoLockMinutes, 1);
    assert.equal(state.expiresAt, fixture.now() + 60000);
    await t.test('only authenticated activity renews the deadline', async () => {
      const originalDeadline = state.expiresAt;
      fixture.advance(30000);
      assert.equal(success<VaultStatus>(await api('GET', '/api/status', { token })).expiresAt, originalDeadline);
      failure(await api('POST', '/api/activity', { token: wrongToken(token) }), 401, 'LOCKED');
      assert.equal(success<VaultStatus>(await api('GET', '/api/status', { token })).expiresAt, originalDeadline);
      const activity = success<{ expiresAt: number }>(await api('POST', '/api/activity', { token }));
      assert.equal(activity.expiresAt, fixture.now() + 60000);
      assert.equal(activity.expiresAt, originalDeadline + 30000);
      state = { ...state, expiresAt: activity.expiresAt };
      fixture.advance(59999);
      assert.equal(success<VaultStatus>(await api('GET', '/api/status', { token })).unlocked, true);
      same(success(await api('GET', '/api/vault', { token })), state, 'read/status requests must not extend expiry');
      fixture.advance(1);
      const expired = success<VaultStatus>(await api('GET', '/api/status', { token }));
      assert.equal(expired.unlocked, false);
      assert.equal(expired.expiresAt, null);
      assert.equal(expired.revision, null);
      failure(await api('GET', '/api/vault', { token }), 401, 'LOCKED');
      failure(await api('POST', '/api/activity', { token }), 401, 'LOCKED');
      failure(await api('GET', '/api/backup', { token }), 401, 'LOCKED');
    });
    await t.test('unlock uses saved auto-lock settings and status never renews the new session', async () => {
      const previous = token;
      const unlocked = success<SessionResponse>(await api('POST', '/api/unlock', { body: { password: PASSWORD } }));
      token = unlocked.token;
      same(unlocked.vault, state.vault, 'automatic locking must not discard persisted data/settings');
      assert.equal(unlocked.expiresAt, fixture.now() + 60000);
      failure(await api('GET', '/api/vault', { token: previous }), 401, 'LOCKED');
      for (let i = 0; i < 3; i++) {
        fixture.advance(19999);
        const status = success<VaultStatus>(await api('GET', '/api/status', { token }));
        assert.equal(status.unlocked, true);
        assert.equal(status.expiresAt, unlocked.expiresAt);
      }
      fixture.advance(3);
      assert.equal(success<VaultStatus>(await api('GET', '/api/status', { token })).unlocked, false);
      failure(await api('GET', '/api/vault', { token }), 401, 'LOCKED');
    });
  });
});

test('encrypted backup and two-phase restore never overwrite without valid confirmation', async t => {
  await withVault(async fixture => {
    const { api } = fixture;
    const created = await create(fixture);
    const token = created.token;
    const archived = success(await api('POST', '/api/entries', { token, body: { revision: created.vault.revision, entry: entry('account', '备份中的账户') } }));
    const backupResponse = await api('GET', '/api/backup', { token });
    assert.equal(backupResponse.statusCode, 200);
    noStore(backupResponse);
    assert.match(String(backupResponse.headers['content-type']), /^application\/octet-stream\b/);
    assert.match(String(backupResponse.headers['content-disposition']), /^attachment; filename="password-vault\.pvlt"$/);
    const backup = backupResponse.body;
    same(backup, await readFile(fixture.storagePath, 'utf8'), 'download must be exactly the encrypted file');
    parseEnvelope(backup);
    const live = success(await api('POST', '/api/entries', { token, body: { revision: archived.vault.revision, entry: entry('server', '恢复前的服务器') } }));
    const before = await readFile(fixture.storagePath, 'utf8');
    const preview = async () => {
      fixture.advance(1000);
      return success<RestorePreview>(await api('POST', '/api/restore/preview', { body: { backup, password: PASSWORD } }));
    };

    await t.test('backup requires auth and invalid preview files/passwords cannot alter disk', async () => {
      failure(await api('GET', '/api/backup'), 401, 'LOCKED');
      failure(await api('GET', '/api/backup', { token: wrongToken(token) }), 401, 'LOCKED');
      for (const invalid of ['not JSON', 'null', '[]', '{}', JSON.stringify({ ...parseEnvelope(backup), version: 2 })]) {
        fixture.advance(1000);
        failure(await api('POST', '/api/restore/preview', { body: { backup: invalid, password: PASSWORD } }), 400, 'INVALID_VAULT');
        await unchanged(fixture, token, live, before);
      }
      fixture.advance(1000);
      failure(await api('POST', '/api/restore/preview', { body: { backup, password: WRONG_PASSWORD } }), 400, 'DECRYPT_FAILED');
      await unchanged(fixture, token, live, before);
      failure(await api('POST', '/api/restore/confirm', { body: {} }), 400, 'RESTORE_EXPIRED');
      assert.deepEqual(await readdir(fixture.directory), ['vault.pvlt']);
    });

    await t.test('preview is metadata only, wrong confirmation fails, and cancel cannot overwrite', async () => {
      const pending = await preview();
      assert.deepEqual(Object.keys(pending).sort(), ['entryCount', 'expiresAt', 'restoreToken', 'willReplace']);
      assert.equal(pending.entryCount, archived.vault.entries.length);
      assert.equal(pending.willReplace, true);
      assert.equal(pending.expiresAt, fixture.now() + 60000);
      assert.ok(/^[A-Za-z0-9_-]{43}$/.test(pending.restoreToken), 'preview must issue an opaque confirmation token');
      await unchanged(fixture, token, live, before);
      failure(await api('POST', '/api/restore/confirm', { body: { restoreToken: wrongToken(pending.restoreToken) } }), 400, 'RESTORE_EXPIRED');
      same(success(await api('POST', '/api/restore/cancel', { body: { restoreToken: pending.restoreToken } })), { ok: true }, 'cancel must succeed');
      failure(await api('POST', '/api/restore/confirm', { body: { restoreToken: pending.restoreToken } }), 400, 'RESTORE_EXPIRED');
      await unchanged(fixture, token, live, before);
      assert.deepEqual(await readdir(fixture.directory), ['vault.pvlt']);
    });

    await t.test('preview expires at exactly one minute without replacing or backing up the live file', async () => {
      const pending = await preview();
      fixture.advance(60000);
      failure(await api('POST', '/api/restore/confirm', { body: { restoreToken: pending.restoreToken } }), 400, 'RESTORE_EXPIRED');
      await unchanged(fixture, token, live, before);
      assert.deepEqual(await readdir(fixture.directory), ['vault.pvlt']);
    });

    await t.test('confirmation replaces ciphertext, preserves before-restore copy and revokes the old token', async () => {
      const pending = await preview();
      const restored = success<SessionResponse>(await api('POST', '/api/restore/confirm', { body: { restoreToken: pending.restoreToken } }));
      same(restored.vault, archived.vault, 'confirmed restore must select the archived snapshot, not merge with live entries');
      same(await readFile(fixture.storagePath, 'utf8'), backup, 'restore must persist the exact verified backup');
      assert.ok(restored.safetyBackupPath, 'replacement must report a safety backup path');
      assert.equal(dirname(restored.safetyBackupPath), fixture.directory, 'safety file must be in the isolated test directory');
      assert.match(basename(restored.safetyBackupPath), /^before-restore-\d+-[a-f0-9-]+\.pvlt$/);
      const safety = await readFile(restored.safetyBackupPath, 'utf8');
      same(safety, before, 'safety backup must be byte-for-byte original ciphertext');
      parseEnvelope(safety);
      for (const text of [PASSWORD, ...live.vault.entries.flatMap(item => [item.name, item.password]).filter(Boolean)]) {
        assert.ok(!safety.includes(text), 'safety backup must not reveal plaintext');
      }
      assert.ok(restored.token !== token, 'restore must rotate the session token');
      failure(await api('GET', '/api/vault', { token }), 401, 'LOCKED');
      failure(await api('GET', '/api/backup', { token }), 401, 'LOCKED');
      failure(await api('POST', '/api/activity', { token }), 401, 'LOCKED');
      assert.equal(success<VaultStatus>(await api('GET', '/api/status', { token })).unlocked, false);
      same(success(await api('GET', '/api/vault', { token: restored.token })).vault, archived.vault, 'new session must read restored data');
      failure(await api('POST', '/api/restore/confirm', { body: { restoreToken: pending.restoreToken } }), 400, 'RESTORE_EXPIRED');
      assert.deepEqual((await readdir(fixture.directory)).sort(), [basename(restored.safetyBackupPath), 'vault.pvlt'].sort());
    });
  });
});

test('atomic failures, concurrent revisions and external file modifications preserve data', async t => {
  await withVault(async fixture => {
    const { api } = fixture;
    const created = await create(fixture);
    let token = created.token;
    let state = success(await api('POST', '/api/entries', { token, body: { revision: created.vault.revision, entry: entry('account', '原始账户') } }));

    await t.test('an existing write lock leaves disk and memory intact, then the same revision can retry', async () => {
      const source = await readFile(fixture.storagePath, 'utf8');
      const guard = join(fixture.directory, 'vault.write-lock');
      const body = { revision: state.vault.revision, entry: entry('server', '写入失败后重试的服务器') };
      await writeFile(guard, 'test-owned write lock', { flag: 'wx' });
      try {
        failure(await api('POST', '/api/entries', { token, body }), 409, 'FILE_BUSY');
        await unchanged(fixture, token, state, source);
        assert.equal(await readFile(guard, 'utf8'), 'test-owned write lock', 'failed writer must not remove another writer\'s guard');
        assert.deepEqual((await readdir(fixture.directory)).sort(), ['vault.pvlt', 'vault.write-lock'].sort());
      } finally {
        await rm(guard, { force: true });
      }
      state = success(await api('POST', '/api/entries', { token, body }));
      assert.equal(state.vault.revision, body.revision + 1);
      assert.equal(state.vault.entries.filter(item => item.name === body.entry.name).length, 1);
      assert.ok((await readFile(fixture.storagePath, 'utf8')) !== source, 'successful retry must persist new ciphertext');
      assert.deepEqual(await readdir(fixture.directory), ['vault.pvlt']);
    });

    await t.test('two simultaneous writes with the same revision produce exactly one winner', async () => {
      const before = state;
      const revision = before.vault.revision;
      const inputs = [entry('account', '并发请求甲'), entry('api', '并发请求乙')];
      const responses = await Promise.all(inputs.map(input => api('POST', '/api/entries', { token, body: { revision, entry: input } })));
      assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
      const winner = responses.findIndex(response => response.statusCode === 200);
      failure(responses[1 - winner], 409, 'REVISION_CONFLICT');
      state = success(responses[winner]);
      assert.equal(state.vault.revision, revision + 1);
      assert.equal(state.vault.entries.length, before.vault.entries.length + 1);
      assert.ok(state.vault.entries.some(item => item.name === inputs[winner].name));
      assert.ok(!state.vault.entries.some(item => item.name === inputs[1 - winner].name));
      same(success(await api('GET', '/api/vault', { token })), state, 'only the successful concurrent operation may become visible');
      assert.deepEqual(await readdir(fixture.directory), ['vault.pvlt']);
    });

    await t.test('external changes reject writes and backup; explicit re-unlock allows a safe retry', async () => {
      const source = await readFile(fixture.storagePath, 'utf8');
      // Whitespace changes the disk fingerprint while retaining a decryptable envelope.
      const external = `${source}\n`;
      await writeFile(fixture.storagePath, external, 'utf8');
      const body = { revision: state.vault.revision, entry: entry('api', '外部修改之后重试') };
      failure(await api('POST', '/api/entries', { token, body }), 409, 'FILE_CHANGED');
      failure(await api('GET', '/api/backup', { token }), 409, 'FILE_CHANGED');
      await unchanged(fixture, token, state, external);
      assert.deepEqual(await readdir(fixture.directory), ['vault.pvlt']);
      success(await api('POST', '/api/lock', { token }));
      fixture.advance(1000);
      const unlocked = success<SessionResponse>(await api('POST', '/api/unlock', { body: { password: PASSWORD } }));
      same(unlocked.vault, state.vault, 'concurrent winner and earlier writes must have survived on disk');
      token = unlocked.token;
      state = success(await api('POST', '/api/entries', { token, body }));
      assert.equal(state.vault.revision, body.revision + 1);
      assert.equal(state.vault.entries.filter(item => item.name === body.entry.name).length, 1);
      assert.deepEqual(await readdir(fixture.directory), ['vault.pvlt']);
    });
  });
});

test('restore into an empty directory and restore write failures preserve the correct file', async t => {
  await withVault(async source => {
    const created = await create(source);
    const saved = success(await source.api('POST', '/api/entries', {
      token: created.token, body: { revision: created.vault.revision, entry: entry('api', '空目录恢复测试') },
    }));
    const backup = (await source.api('GET', '/api/backup', { token: created.token })).body;

    await t.test('verified backup can initialize an empty vault without creating a safety copy', async () => {
      await withVault(async target => {
        const preview = success<RestorePreview>(await target.api('POST', '/api/restore/preview', { body: { backup, password: PASSWORD } }));
        assert.equal(preview.willReplace, false);
        assert.equal(preview.entryCount, 1);
        assert.deepEqual(await readdir(target.directory), []);
        const restored = success<SessionResponse>(await target.api('POST', '/api/restore/confirm', { body: { restoreToken: preview.restoreToken } }));
        same(restored.vault, saved.vault, 'fresh restore must preserve all entries and settings');
        assert.equal(restored.safetyBackupPath, undefined);
        same(await readFile(target.storagePath, 'utf8'), backup, 'fresh restore must preserve the encrypted backup bytes');
        assert.deepEqual(await readdir(target.directory), ['vault.pvlt']);
      });
    });

    await t.test('a save after preview invalidates replacement rather than losing new entries', async () => {
      source.advance(1000);
      const preview = success<RestorePreview>(await source.api('POST', '/api/restore/preview', { body: { backup, password: PASSWORD } }));
      const newer = success(await source.api('POST', '/api/entries', {
        token: created.token, body: { revision: saved.vault.revision, entry: entry('server', '预览之后新保存') },
      }));
      const original = await readFile(source.storagePath, 'utf8');
      failure(await source.api('POST', '/api/restore/confirm', { body: { restoreToken: preview.restoreToken } }), 409, 'FILE_CHANGED');
      await unchanged(source, created.token, newer, original);
      assert.deepEqual(await readdir(source.directory), ['vault.pvlt']);
    });

    await t.test('restore with a busy disk leaves the live file untouched and permits a fresh preview', async () => {
      source.advance(1000);
      const preview = success<RestorePreview>(await source.api('POST', '/api/restore/preview', { body: { backup, password: PASSWORD } }));
      const original = await readFile(source.storagePath, 'utf8');
      const state = success(await source.api('GET', '/api/vault', { token: created.token }));
      const guard = join(source.directory, 'vault.write-lock');
      await writeFile(guard, 'test-owned lock', { flag: 'wx' });
      try {
        failure(await source.api('POST', '/api/restore/confirm', { body: { restoreToken: preview.restoreToken } }), 409, 'FILE_BUSY');
        await unchanged(source, created.token, state, original);
        assert.deepEqual((await readdir(source.directory)).sort(), ['vault.pvlt', 'vault.write-lock'].sort());
      } finally {
        await rm(guard);
      }
      source.advance(1000);
      const retry = success<RestorePreview>(await source.api('POST', '/api/restore/preview', { body: { backup, password: PASSWORD } }));
      const restored = success<SessionResponse>(await source.api('POST', '/api/restore/confirm', { body: { restoreToken: retry.restoreToken } }));
      same(restored.vault, saved.vault, 'retry must restore the verified archive');
      assert.ok(restored.safetyBackupPath);
      same(await readFile(restored.safetyBackupPath, 'utf8'), original, 'retry must preserve the original ciphertext');
    });
  });
});
