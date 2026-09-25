import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import test, { type TestContext } from 'node:test';
import { buildApp } from '../server/app.js';
import { decrypt, deriveKey, parseEnvelope } from '../server/crypto.js';
import type { ChangeMasterPasswordResponse, EntryInput, SessionResponse, VaultResponse } from '../shared/types.js';

const OLD = '  old-master-中文-e\u0301  ';
const NEW = '  new-master-中文-e\u0301  ';
const origin = 'http://127.0.0.1:47821';
const endpoint = '/api/master-password';
const entry: EntryInput = {
  type: 'api', name: '密码变更测试凭据', username: '测试标识', address: 'https://example.invalid', port: '',
  password: '', apiKey: '  保留前后空格-API-key  ', secret: '测试-Secret', notes: '保留所有条目和设置',
};

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'vault-password-change-'));
  const directory = await realpath(temporary);
  let now = Date.UTC(2026, 8, 25);
  let nowOverride: (() => number) | undefined;
  const options = { directory, origin, now: () => nowOverride ? nowOverride() : now };
  let app = buildApp(options);
  const others: ReturnType<typeof buildApp>[] = [];
  t.after(async () => {
    await Promise.all([app.close(), ...others.map(other => other.close())]);
    await rm(temporary, { recursive: true, force: true });
  });
  const headers = { host: new URL(origin).host, origin, 'x-vault-client': 'local-web' };
  const api = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, token?: string) => app.inject({
    method, url, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body), headers: { ...headers, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }),
  });
  const created = await api('POST', '/api/create', { password: OLD });
  assert.equal(created.statusCode, 200);
  const session = created.json<SessionResponse>();
  const added = await api('POST', '/api/entries', { revision: session.vault.revision, entry }, session.token);
  assert.equal(added.statusCode, 200);
  const configured = await api('PUT', '/api/settings', { revision: added.json<VaultResponse>().vault.revision, autoLockMinutes: 15 }, session.token);
  assert.equal(configured.statusCode, 200);
  const state = configured.json<VaultResponse>();
  const body = { currentPassword: OLD, newPassword: NEW, confirmPassword: NEW, revision: state.vault.revision };
  return {
    directory, path: join(directory, 'vault.pvlt'), session, state, body, api,
    headers,
    advance() { now += 1001; },
    overrideClock(value?: () => number) { nowOverride = value; },
    time: () => now,
    app: () => app,
    async restart() { await app.close(); app = buildApp(options); },
    async other() { const other = buildApp(options); others.push(other); await other.ready(); return other; },
  };
}

function failure(response: { statusCode: number; json: () => any }, status: number, code: string) {
  assert.equal(response.statusCode, status);
  assert.equal(response.json().code, code);
}

async function decodes(source: string, password: string) {
  const envelope = parseEnvelope(source);
  const key = await deriveKey(password, Buffer.from(envelope.salt, 'base64'));
  try { return decrypt(envelope, key); } finally { key.fill(0); }
}

test('master password changes require authentication, local origin and valid matching input', async t => {
  const f = await fixture(t);
  const original = await readFile(f.path, 'utf8');
  failure(await f.api('POST', endpoint, f.body), 401, 'LOCKED');
  failure(await f.api('POST', endpoint, f.body, 'invalid'), 401, 'LOCKED');
  const foreign = await f.app().inject({ method: 'POST', url: endpoint, headers: { ...f.headers, origin: 'https://example.invalid', authorization: `Bearer ${f.session.token}` }, payload: f.body });
  failure(foreign, 403, 'FORBIDDEN_ORIGIN');
  const cases: [unknown, number, string][] = [
    [null, 400, 'INVALID_INPUT'],
    [{ ...f.body, currentPassword: '' }, 400, 'INVALID_INPUT'],
    [{ ...f.body, currentPassword: null }, 400, 'INVALID_INPUT'],
    [{ ...f.body, newPassword: 'short', confirmPassword: 'short' }, 400, 'INVALID_INPUT'],
    [{ ...f.body, newPassword: 'a'.repeat(1025) }, 400, 'INVALID_INPUT'],
    [{ ...f.body, confirmPassword: 'not-matching-password' }, 400, 'PASSWORD_MISMATCH'],
    [{ ...f.body, newPassword: OLD, confirmPassword: OLD }, 400, 'NEW_PASSWORD_UNCHANGED'],
    [{ ...f.body, revision: f.body.revision - 1 }, 409, 'REVISION_CONFLICT'],
  ];
  for (const [body, status, code] of cases) failure(await f.api('POST', endpoint, body, f.session.token), status, code);
  assert.equal(await readFile(f.path, 'utf8'), original);
  const live = await f.api('GET', '/api/vault', undefined, f.session.token);
  assert.ok(isDeepStrictEqual(live.json(), f.state));
});

test('wrong current password is rate limited and does not alter the file or session', async t => {
  const f = await fixture(t);
  const original = await readFile(f.path, 'utf8');
  f.advance();
  failure(await f.api('POST', endpoint, { ...f.body, currentPassword: 'wrong-password' }, f.session.token), 400, 'WRONG_MASTER_PASSWORD');
  failure(await f.api('POST', endpoint, f.body, f.session.token), 429, 'TRY_LATER');
  f.advance();
  failure(await f.api('POST', endpoint, { ...f.body, currentPassword: OLD.trim() }, f.session.token), 400, 'WRONG_MASTER_PASSWORD');
  assert.equal(await readFile(f.path, 'utf8'), original);
  assert.ok(isDeepStrictEqual((await f.api('GET', '/api/vault', undefined, f.session.token)).json(), f.state));
});

test('new salt and encryption preserve all records, invalidate sessions and leave old backups unchanged', async t => {
  const f = await fixture(t);
  const original = await readFile(f.path, 'utf8');
  const backupPath = join(f.directory, 'before-restore-test.pvlt');
  await writeFile(backupPath, original, { flag: 'wx' });
  f.advance();
  const preview = await f.api('POST', '/api/restore/preview', { backup: original, password: OLD });
  assert.equal(preview.statusCode, 200);
  f.advance();
  const response = await f.api('POST', endpoint, f.body, f.session.token);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(response.json()), ['status']);
  const changed = response.json<ChangeMasterPasswordResponse>();
  assert.equal(changed.status.unlocked, false);
  assert.equal(changed.status.storagePath, f.path);
  assert.equal(changed.status.revision, null);
  const updated = await readFile(f.path, 'utf8');
  const before = parseEnvelope(original);
  const after = parseEnvelope(updated);
  assert.notEqual(after.salt, before.salt);
  assert.notEqual(after.iv, before.iv);
  assert.notEqual(after.ciphertext, before.ciphertext);
  const decoded = await decodes(updated, NEW);
  assert.ok(isDeepStrictEqual(decoded, { ...f.state.vault, revision: f.state.vault.revision + 1 }));
  for (const text of [OLD, NEW, entry.name, entry.apiKey, entry.secret]) assert.ok(!updated.includes(text));
  await assert.rejects(decodes(updated, OLD), { code: 'DECRYPT_FAILED' });
  await assert.rejects(decodes(updated, NEW.trim()), { code: 'DECRYPT_FAILED' });
  assert.equal(await readFile(backupPath, 'utf8'), original);
  assert.ok(isDeepStrictEqual(await decodes(original, OLD), f.state.vault));
  await assert.rejects(decodes(original, NEW), { code: 'DECRYPT_FAILED' });
  assert.deepEqual((await readdir(f.directory)).sort(), ['before-restore-test.pvlt', 'vault.pvlt']);
  failure(await f.api('GET', '/api/vault', undefined, f.session.token), 401, 'LOCKED');
  failure(await f.api('POST', '/api/restore/confirm', { restoreToken: preview.json().restoreToken }), 400, 'RESTORE_EXPIRED');
  f.advance();
  failure(await f.api('POST', '/api/unlock', { password: OLD }), 400, 'DECRYPT_FAILED');
  await f.restart();
  const unlocked = await f.api('POST', '/api/unlock', { password: NEW });
  assert.equal(unlocked.statusCode, 200);
  assert.ok(isDeepStrictEqual(unlocked.json<SessionResponse>().vault, decoded));
  const backup = await f.api('GET', '/api/backup', undefined, unlocked.json<SessionResponse>().token);
  assert.equal(backup.body, updated);
});

test('write conflicts and external modifications keep the original password usable', async t => {
  const f = await fixture(t);
  const original = await readFile(f.path, 'utf8');
  const guard = join(f.directory, 'vault.write-lock');
  await writeFile(guard, 'test-owned-guard', { flag: 'wx' });
  f.advance();
  failure(await f.api('POST', endpoint, f.body, f.session.token), 409, 'FILE_BUSY');
  assert.equal(await readFile(f.path, 'utf8'), original);
  assert.ok(isDeepStrictEqual((await f.api('GET', '/api/vault', undefined, f.session.token)).json(), f.state));
  assert.equal(await readFile(guard, 'utf8'), 'test-owned-guard');
  await rm(guard);
  const changedOnDisk = `${original}\n`;
  await writeFile(f.path, changedOnDisk);
  f.advance();
  failure(await f.api('POST', endpoint, f.body, f.session.token), 409, 'FILE_CHANGED');
  assert.equal(await readFile(f.path, 'utf8'), changedOnDisk);
  assert.ok(isDeepStrictEqual(await decodes(changedOnDisk, OLD), f.state.vault));
  assert.deepEqual(await readdir(f.directory), ['vault.pvlt']);
  f.advance();
  const refreshed = await f.api('POST', '/api/unlock', { password: OLD });
  f.advance();
  const retry = await f.api('POST', endpoint, f.body, refreshed.json<SessionResponse>().token);
  assert.equal(retry.statusCode, 200);
});

test('expiring during key derivation cannot commit a new password', async t => {
  const f = await fixture(t);
  const original = await readFile(f.path, 'utf8');
  f.advance();
  const time = f.time();
  let reads = 0;
  f.overrideClock(() => ++reads >= 5 ? time + 16 * 60000 : time);
  failure(await f.api('POST', endpoint, f.body, f.session.token), 401, 'LOCKED');
  f.overrideClock();
  assert.equal(await readFile(f.path, 'utf8'), original);
  assert.deepEqual(await readdir(f.directory), ['vault.pvlt']);
  failure(await f.api('GET', '/api/vault', undefined, f.session.token), 401, 'LOCKED');
  f.advance();
  assert.equal((await f.api('POST', '/api/unlock', { password: OLD })).statusCode, 200);
});

test('duplicate changes commit only once and another server cannot keep using the old key', async t => {
  const f = await fixture(t);
  const other = await f.other();
  const opened = await other.inject({ method: 'POST', url: '/api/unlock', headers: f.headers, payload: { password: OLD } });
  assert.equal(opened.statusCode, 200);
  const otherToken = opened.json<SessionResponse>().token;
  f.advance();
  const results = await Promise.all([f.api('POST', endpoint, f.body, f.session.token), f.api('POST', endpoint, f.body, f.session.token)]);
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 401]);
  for (const url of ['/api/vault', '/api/backup']) {
    failure(await other.inject({ method: 'GET', url, headers: { ...f.headers, authorization: `Bearer ${otherToken}` } }), 401, 'LOCKED');
  }
  const status = await other.inject({ method: 'GET', url: '/api/status', headers: { ...f.headers, authorization: `Bearer ${otherToken}` } });
  assert.equal(status.json().unlocked, false);
  f.advance();
  const fresh = await other.inject({ method: 'POST', url: '/api/unlock', headers: f.headers, payload: { password: NEW } });
  assert.equal(fresh.statusCode, 200);
  assert.ok(isDeepStrictEqual(fresh.json<SessionResponse>().vault.entries, f.state.vault.entries));
});

test('password changes follow the custom directory and do not re-encrypt retained legacy copies', async t => {
  const f = await fixture(t);
  const original = await readFile(f.path, 'utf8');
  const target = join(f.directory, 'custom-location');
  await mkdir(target);
  const moved = await f.api('POST', '/api/storage-location', { directory: target, storagePath: f.path, revision: f.state.vault.revision, confirmed: true }, f.session.token);
  assert.equal(moved.statusCode, 200);
  f.advance();
  const unlocked = await f.api('POST', '/api/unlock', { password: OLD });
  f.advance();
  const changed = await f.api('POST', endpoint, f.body, unlocked.json<SessionResponse>().token);
  assert.equal(changed.statusCode, 200);
  const currentPath = join(target, 'vault.pvlt');
  assert.equal(changed.json<ChangeMasterPasswordResponse>().status.storagePath, currentPath);
  assert.equal(await readFile(f.path, 'utf8'), original);
  const current = await readFile(currentPath, 'utf8');
  assert.ok(isDeepStrictEqual((await decodes(current, NEW)).entries, f.state.vault.entries));
  await assert.rejects(decodes(current, OLD), { code: 'DECRYPT_FAILED' });
  await f.restart();
  const reopened = await f.api('POST', '/api/unlock', { password: NEW });
  assert.equal(reopened.statusCode, 200);
});
