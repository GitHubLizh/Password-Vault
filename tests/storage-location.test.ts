import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../server/app.js';
import { parseEnvelope } from '../server/crypto.js';
import { VaultError } from '../server/errors.js';
import { storageDirectory } from '../server/storage-location.js';
import type { EntryInput, RestorePreview, SessionResponse, StorageLocationResponse, VaultResponse, VaultStatus } from '../shared/types.js';

const ORIGIN = 'http://127.0.0.1:47821';
const PASSWORD = '  目录迁移测试-主密码-e\u0301  ';
type Method = 'GET' | 'POST' | 'PUT';
interface RequestOptions { token?: string; body?: unknown }
interface Client {
  api(method: Method, url: string, options?: RequestOptions): Promise<LightMyRequestResponse>;
  ready(): Promise<void>;
  close(): Promise<void>;
}
interface Fixture {
  root: string;
  profile: string;
  originalPath: string;
  configPath: string;
  advance(): void;
  open(): Client;
}

async function withVault(operation: (fixture: Fixture) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'local-vault-location-test-'));
  const apps = new Set<ReturnType<typeof buildApp>>();
  let now = Date.UTC(2026, 0, 2, 3, 4, 5);
  try {
    const root = await realpath(temporary);
    const profile = join(root, 'profile');
    await mkdir(profile);
    await operation({
      root, profile, originalPath: join(profile, 'vault.pvlt'), configPath: join(profile, 'storage-location.json'),
      advance() { now += 1000; },
      open() {
        // ready/inject loads the shared test-owned profile asynchronously.
        const app = buildApp({ directory: profile, origin: ORIGIN, now: () => now });
        apps.add(app);
        return {
          async ready() { await app.ready(); },
          async close() { await app.close(); apps.delete(app); },
          async api(method, url, options = {}) {
            const headers: Record<string, string> = { host: new URL(ORIGIN).host, 'x-vault-client': 'local-web' };
            if (method !== 'GET') headers.origin = ORIGIN;
            if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
            if (options.body !== undefined) headers['content-type'] = 'application/json';
            return app.inject({
              method, url, headers,
              ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
            });
          },
        };
      },
    });
  } finally {
    const closed = await Promise.allSettled([...apps].map(app => app.close()));
    // Only remove the unique directory allocated above, including this test's child directories.
    await rm(temporary, { recursive: true, force: true });
    assert.ok(closed.every(result => result.status === 'fulfilled'), 'test instances must close cleanly');
  }
}

function same(actual: unknown, expected: unknown, message: string): void {
  // Do not print passwords, vault snapshots, ciphertext or tokens on assertion failure.
  assert.ok(isDeepStrictEqual(actual, expected), message);
}

function noStore(response: LightMyRequestResponse): void {
  assert.match(String(response.headers['cache-control']), /\bno-store\b/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
}

function success<T = VaultResponse>(response: LightMyRequestResponse): T {
  assert.equal(response.statusCode, 200, 'request must succeed');
  noStore(response);
  return response.json<T>();
}

function failure(response: LightMyRequestResponse, status: number, code: string): void {
  assert.equal(response.statusCode, status, 'request must fail with the expected status');
  noStore(response);
  const body = response.json<{ code: string; message: string }>();
  assert.equal(body.code, code);
  assert.deepEqual(Object.keys(body).sort(), ['code', 'message']);
  assert.equal(typeof body.message, 'string');
}

async function absent(path: string): Promise<void> {
  await assert.rejects(stat(path), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
}

function migration(directory: string, storagePath: string, revision: number) {
  return { directory, storagePath, revision, confirmed: true };
}

function locked(storagePath: string): VaultStatus {
  return { exists: true, unlocked: false, storagePath, autoLockMinutes: 5, expiresAt: null, revision: null };
}

function entry(name: string): EntryInput {
  return {
    type: 'account', name, username: '  测试用户-e\u0301  ', address: 'https://example.invalid', port: '',
    password: '  迁移凭据-秘密-e\u0301\t\n  ', apiKey: '', secret: '', notes: '仅供隔离回归测试',
  };
}

async function create(client: Client): Promise<SessionResponse> {
  return success<SessionResponse>(await client.api('POST', '/api/create', { body: { password: PASSWORD } }));
}

async function unlock(fixture: Fixture, client: Client): Promise<SessionResponse> {
  fixture.advance();
  return success<SessionResponse>(await client.api('POST', '/api/unlock', { body: { password: PASSWORD } }));
}

async function preview(fixture: Fixture, client: Client, backup: Buffer): Promise<RestorePreview> {
  fixture.advance();
  return success<RestorePreview>(await client.api('POST', '/api/restore/preview', {
    body: { backup: backup.toString('utf8'), password: PASSWORD },
  }));
}

async function unchanged(client: Client, token: string, storagePath: string, state: VaultResponse, source: Buffer): Promise<void> {
  same(await readFile(storagePath), source, 'rejected migration must preserve the current file bytes');
  same(success(await client.api('GET', '/api/vault', { token })), {
    vault: state.vault, expiresAt: state.expiresAt,
  }, 'rejected migration must preserve the session snapshot and expiry');
  const status = success<VaultStatus>(await client.api('GET', '/api/status', { token }));
  assert.equal(status.storagePath, storagePath);
  assert.equal(status.unlocked, true);
  assert.equal(status.revision, state.vault.revision);
  assert.equal(status.expiresAt, state.expiresAt);
}

async function configured(fixture: Fixture, directory: string): Promise<void> {
  same(JSON.parse(await readFile(fixture.configPath, 'utf8')), { version: 1, directory }, 'only the profile must persist the selected directory');
}

async function download(client: Client, token: string): Promise<Buffer> {
  const response = await client.api('GET', '/api/backup', { token });
  assert.equal(response.statusCode, 200, 'encrypted backup must be available');
  noStore(response);
  assert.match(String(response.headers['content-type']), /^application\/octet-stream\b/);
  return response.rawPayload;
}

test('storage directory validation rejects unsafe paths without filesystem or network access', async t => {
  // Pure validation prevents a regression from touching network shares or device paths.
  for (const value of [undefined, null, 42, '', '   ', '.', '..', 'relative/path', '\\\\server.invalid\\share', '//server.invalid/share', 'x'.repeat(4097), `${tmpdir()}\x00bad`, join(tmpdir(), 'file.pvlt')]) {
    assert.throws(() => storageDirectory(value), (error: unknown) =>
      error instanceof VaultError && error.statusCode === 400 && error.code === 'INVALID_DIRECTORY');
  }
  await t.test('Windows drive-relative paths and device names are invalid', { skip: process.platform !== 'win32' }, () => {
    for (const value of ['C:relative', '\\root-relative', ...['CON', 'nul.txt', 'AUX', 'COM1', 'LPT9', 'COM¹.txt', 'trailing.', 'trailing '].map(name => join(tmpdir(), name, 'child'))]) {
      assert.throws(() => storageDirectory(value), (error: unknown) =>
        error instanceof VaultError && error.statusCode === 400 && error.code === 'INVALID_DIRECTORY');
    }
  });
});

test('migration requires an unlocked session, explicit confirmation and current revision/path', async t => {
  await withVault(async fixture => {
    const client = fixture.open();
    const target = join(fixture.root, 'not-created');
    const body = migration(target, fixture.originalPath, 1);
    failure(await client.api('POST', '/api/storage-location', { body }), 401, 'LOCKED');
    assert.deepEqual(await readdir(fixture.profile), []);
    await absent(target);
    const created = await create(client);
    const source = await readFile(fixture.originalPath);

    await t.test('missing or incorrect tokens do not inherit a live session', async () => {
      const wrong = `${created.token[0] === 'A' ? 'B' : 'A'}${created.token.slice(1)}`;
      for (const token of [undefined, wrong]) {
        failure(await client.api('POST', '/api/storage-location', { token, body }), 401, 'LOCKED');
        await unchanged(client, created.token, fixture.originalPath, created, source);
      }
    });

    const state = success(await client.api('PUT', '/api/settings', {
      token: created.token, body: { revision: 1, autoLockMinutes: 15 },
    }));
    const current = migration(target, fixture.originalPath, state.vault.revision);
    const bytes = await readFile(fixture.originalPath);
    await t.test('unconfirmed, stale and malformed requests cannot create a target', async () => {
      const cases: Array<[unknown, number, string]> = [
        [null, 400, 'INVALID_INPUT'],
        [{ ...current, confirmed: undefined }, 400, 'INVALID_INPUT'],
        [{ ...current, confirmed: false }, 400, 'INVALID_INPUT'],
        [{ ...current, confirmed: 'true' }, 400, 'INVALID_INPUT'],
        [{ ...current, revision: 1 }, 409, 'REVISION_CONFLICT'],
        [{ ...current, storagePath: join(fixture.root, 'stale', 'vault.pvlt') }, 400, 'INVALID_INPUT'],
        [{ ...current, storagePath: fixture.profile }, 400, 'INVALID_INPUT'],
        [{ ...current, directory: null }, 400, 'INVALID_DIRECTORY'],
        [{ ...current, directory: join(fixture.root, 'not-a-directory.pvlt') }, 400, 'INVALID_DIRECTORY'],
      ];
      for (const [invalid, status, code] of cases) {
        failure(await client.api('POST', '/api/storage-location', { token: created.token, body: invalid }), status, code);
        await unchanged(client, created.token, fixture.originalPath, state, bytes);
      }
      await absent(target);
      assert.deepEqual(await readdir(fixture.root), ['profile']);
      assert.deepEqual(await readdir(fixture.profile), ['vault.pvlt']);
    });

    await t.test('same directory and unnormalized dot aliases are not migrations', async () => {
      for (const directory of [fixture.profile, `${fixture.profile}${sep}.${sep}`, `${fixture.profile}${sep}..${sep}${basename(fixture.profile)}`]) {
        failure(await client.api('POST', '/api/storage-location', {
          token: created.token, body: { ...current, directory },
        }), 400, 'SAME_DIRECTORY');
        await unchanged(client, created.token, fixture.originalPath, state, bytes);
      }
      assert.deepEqual(await readdir(fixture.profile), ['vault.pvlt']);
    });

    success(await client.api('POST', '/api/lock', { token: created.token }));
    failure(await client.api('POST', '/api/storage-location', { token: created.token, body: current }), 401, 'LOCKED');
    same(await readFile(fixture.originalPath), bytes, 'locked requests must not change the original ciphertext');
    await absent(target);
    await absent(fixture.configPath);
  });
});

test('existing target files, invalid directories and busy vault locks are never overwritten', async t => {
  await withVault(async fixture => {
    const client = fixture.open();
    const created = await create(client);
    const source = await readFile(fixture.originalPath);
    const submit = (directory: string) => client.api('POST', '/api/storage-location', {
      token: created.token, body: migration(directory, fixture.originalPath, created.vault.revision),
    });

    await t.test('both populated and empty vault.pvlt files block migration', async () => {
      for (const [name, bytes] of [['occupied', Buffer.concat([source, Buffer.from('\n')])], ['empty', Buffer.alloc(0)]] as const) {
        const target = join(fixture.root, name);
        await mkdir(target);
        await writeFile(join(target, 'vault.pvlt'), bytes, { flag: 'wx' });
        failure(await submit(target), 409, 'TARGET_EXISTS');
        same(await readFile(join(target, 'vault.pvlt')), bytes, 'an existing target must remain byte-for-byte unchanged');
        await unchanged(client, created.token, fixture.originalPath, created, source);
        assert.deepEqual(await readdir(target), ['vault.pvlt']);
        assert.deepEqual(await readdir(fixture.profile), ['vault.pvlt']);
      }
    });

    await t.test('a file used as the directory or its parent is rejected', async () => {
      const file = join(fixture.root, 'ordinary-file');
      await writeFile(file, 'test-owned file', { flag: 'wx' });
      for (const directory of [file, join(file, 'child')]) {
        failure(await submit(directory), 400, 'INVALID_DIRECTORY');
        assert.equal(await readFile(file, 'utf8'), 'test-owned file');
        await unchanged(client, created.token, fixture.originalPath, created, source);
      }
    });

    await t.test('current and target busy locks survive while acquired locks are cleaned', async () => {
      const target = join(fixture.root, 'busy-target');
      await mkdir(target);
      for (const directory of [fixture.profile, target]) {
        const guard = join(directory, 'vault.write-lock');
        await writeFile(guard, 'test-owned competing writer', { flag: 'wx' });
        try {
          failure(await submit(target), 409, 'FILE_BUSY');
          await unchanged(client, created.token, fixture.originalPath, created, source);
          assert.equal(await readFile(guard, 'utf8'), 'test-owned competing writer');
          assert.deepEqual((await readdir(fixture.profile)).sort(), directory === fixture.profile ? ['vault.pvlt', 'vault.write-lock'] : ['vault.pvlt']);
          assert.deepEqual(await readdir(target), directory === target ? ['vault.write-lock'] : []);
        } finally {
          await rm(guard);
        }
      }
      assert.deepEqual(await readdir(target), []);
    });
    await absent(fixture.configPath);
    assert.deepEqual(await readdir(fixture.profile), ['vault.pvlt']);
  });
});

test('external source changes reject migration instead of copying stale session data', async () => {
  await withVault(async fixture => {
    const client = fixture.open();
    const created = await create(client);
    // Keep a valid encrypted envelope but change its fingerprint on disk.
    const external = Buffer.concat([await readFile(fixture.originalPath), Buffer.from('\n')]);
    await writeFile(fixture.originalPath, external);
    const target = join(fixture.root, 'external-change-target');
    const body = migration(target, fixture.originalPath, created.vault.revision);
    failure(await client.api('POST', '/api/storage-location', { token: created.token, body }), 409, 'FILE_CHANGED');
    await unchanged(client, created.token, fixture.originalPath, created, external);
    assert.deepEqual(await readdir(target), []);
    assert.deepEqual(await readdir(fixture.profile), ['vault.pvlt']);
    const fresh = await unlock(fixture, client);
    const result = success<StorageLocationResponse>(await client.api('POST', '/api/storage-location', { token: fresh.token, body }));
    assert.deepEqual(result, { previousStoragePath: fixture.originalPath, status: locked(join(target, 'vault.pvlt')) });
    same(await readFile(join(target, 'vault.pvlt')), external, 'explicit re-unlock must allow copying the actual external bytes');
    same(await readFile(fixture.originalPath), external, 'successful retry must retain the external source');
  });
});

test('configuration commit failure rolls back the target without changing location, session or pending restore', async () => {
  await withVault(async fixture => {
    const client = fixture.open();
    const created = await create(client);
    const source = await readFile(fixture.originalPath);
    const first = join(fixture.root, 'selected');
    success<StorageLocationResponse>(await client.api('POST', '/api/storage-location', {
      token: created.token, body: migration(first, fixture.originalPath, created.vault.revision),
    }));
    const state = await unlock(fixture, client);
    const currentPath = join(first, 'vault.pvlt');
    const config = await readFile(fixture.configPath);
    const pending = await preview(fixture, client, source);
    const target = join(fixture.root, 'rollback-target');
    const body = migration(target, currentPath, state.vault.revision);
    const guard = join(fixture.profile, 'storage-location.write-lock');
    // A directory at the guard name deterministically fails save(), even with admin privileges.
    await mkdir(guard);
    await writeFile(join(guard, 'owner'), 'test-owned config writer', { flag: 'wx' });
    try {
      failure(await client.api('POST', '/api/storage-location', { token: state.token, body }), 409, 'FILE_BUSY');
      await unchanged(client, state.token, currentPath, state, source);
      same(await readFile(fixture.originalPath), source, 'the legacy copy must not change on rollback');
      same(await readFile(fixture.configPath), config, 'failed configuration save must retain the previous configuration bytes');
      assert.deepEqual(await readdir(target), [], 'rollback must remove its target ciphertext and write lock');
      assert.deepEqual(await readdir(first), ['vault.pvlt']);
      assert.deepEqual((await readdir(fixture.profile)).sort(), ['storage-location.json', 'storage-location.write-lock', 'vault.pvlt']);
      assert.equal(await readFile(join(guard, 'owner'), 'utf8'), 'test-owned config writer');
      assert.deepEqual(await readdir(guard), ['owner']);
    } finally {
      await rm(guard, { recursive: true });
    }
    // A failed migration must not revoke a previously valid restore preview.
    const restored = success<SessionResponse>(await client.api('POST', '/api/restore/confirm', { body: { restoreToken: pending.restoreToken } }));
    same(restored.vault, state.vault, 'pending restore must survive a configuration commit failure');
    assert.ok(restored.safetyBackupPath, 'the still-valid restore must create a safety copy');
    assert.equal(dirname(restored.safetyBackupPath), first);
    same(await readFile(restored.safetyBackupPath), source, 'rollback must retain the current restore source');
    const retried = success<StorageLocationResponse>(await client.api('POST', '/api/storage-location', { token: restored.token, body }));
    assert.deepEqual(retried, { previousStoragePath: currentPath, status: locked(join(target, 'vault.pvlt')) });
    await configured(fixture, target);
    same(await readFile(join(target, 'vault.pvlt')), source, 'retry must be able to create the cleaned target without overwrite');
    assert.deepEqual(await readdir(target), ['vault.pvlt']);
  });
});

test('migration persists across restarts, revokes tokens, preserves history and moves later writes/restores', async () => {
  await withVault(async fixture => {
    let client = fixture.open();
    const created = await create(client);
    const archived = success(await client.api('POST', '/api/entries', {
      token: created.token, body: { revision: created.vault.revision, entry: entry('迁移前的账户') },
    }));
    const backup = await download(client, created.token);
    success(await client.api('PUT', '/api/settings', {
      token: created.token, body: { revision: archived.vault.revision, autoLockMinutes: 15 },
    }));
    const beforeRestore = await readFile(fixture.originalPath);
    const historicalPreview = await preview(fixture, client, backup);
    const restored = success<SessionResponse>(await client.api('POST', '/api/restore/confirm', { body: { restoreToken: historicalPreview.restoreToken } }));
    assert.ok(restored.safetyBackupPath, 'setup must produce a real before-restore file');
    const historicalPath = restored.safetyBackupPath;
    assert.equal(dirname(historicalPath), fixture.profile);
    const pending = await preview(fixture, client, backup);
    const first = join(fixture.root, '自定义 目录', 'nested');
    const firstPath = join(first, 'vault.pvlt');
    await absent(dirname(first));
    const body = migration(`${first}${sep}.${sep}`, fixture.originalPath, restored.vault.revision);
    const duplicates = await Promise.all([0, 1].map(() =>
      client.api('POST', '/api/storage-location', { token: restored.token, body })));
    assert.deepEqual(duplicates.map(response => response.statusCode).sort(), [200, 401], 'concurrent duplicates must commit exactly once');
    failure(duplicates.find(response => response.statusCode === 401)!, 401, 'LOCKED');
    const result = success<StorageLocationResponse>(duplicates.find(response => response.statusCode === 200)!);
    same(result, { previousStoragePath: fixture.originalPath, status: locked(firstPath) }, 'migration must return only the old path and locked target status');
    await configured(fixture, first);
    same(await readFile(firstPath), backup, 'migration must copy identical encrypted bytes, not re-encrypt');
    same(await readFile(fixture.originalPath), backup, 'migration must retain the old vault');
    same(await readFile(historicalPath), beforeRestore, 'migration must retain all old before-restore bytes');
    assert.deepEqual((await readdir(fixture.profile)).sort(), [basename(historicalPath), 'storage-location.json', 'vault.pvlt'].sort());
    assert.deepEqual(await readdir(first), ['vault.pvlt'], 'history and profile configuration must not be moved to the target');
    assert.deepEqual(parseEnvelope(backup.toString('utf8')).kdf, { name: 'scrypt', N: 131072, r: 8, p: 1 });
    for (const secret of [PASSWORD, archived.vault.entries[0].name, archived.vault.entries[0].password]) {
      assert.ok(!backup.includes(Buffer.from(secret)), 'migrated files must contain no plaintext secrets');
    }

    for (const [method, path, requestBody] of [
      ['GET', '/api/vault'], ['GET', '/api/backup'], ['POST', '/api/activity'],
      ['PUT', '/api/settings', { revision: archived.vault.revision, autoLockMinutes: 1 }],
      ['POST', '/api/storage-location', body],
    ] as const) {
      failure(await client.api(method, path, { token: restored.token, body: requestBody }), 401, 'LOCKED');
    }
    // Check before re-unlock/restart, which would independently discard pending restore state.
    failure(await client.api('POST', '/api/restore/confirm', { body: { restoreToken: pending.restoreToken } }), 400, 'RESTORE_EXPIRED');
    assert.deepEqual(success<VaultStatus>(await client.api('GET', '/api/status', { token: restored.token })), locked(firstPath));
    same(await readFile(firstPath), backup, 'replay and expired restore must not alter the target');

    await client.close();
    client = fixture.open(); // options.directory remains the original profile, not the new data directory.
    await client.ready();
    assert.deepEqual(success<VaultStatus>(await client.api('GET', '/api/status')), locked(firstPath));
    const reopened = await unlock(fixture, client);
    same(reopened.vault, archived.vault, 'restart must recover the migrated snapshot');
    failure(await client.api('POST', '/api/storage-location', { token: reopened.token, body }), 400, 'INVALID_INPUT');
    const newer = success(await client.api('POST', '/api/entries', {
      token: reopened.token, body: { revision: reopened.vault.revision, entry: entry('仅写入新目录的账户') },
    }));
    const newBytes = await readFile(firstPath);
    assert.ok(!newBytes.equals(backup), 'new writes must update the selected file');
    same(await readFile(fixture.originalPath), backup, 'new writes must not update the legacy vault');
    same(await readFile(historicalPath), beforeRestore, 'new writes must not change legacy restore history');
    same(await download(client, reopened.token), newBytes, 'backup must download the selected file, not the retained old file');

    // The two vaults now differ: reopening the old copy cannot accidentally satisfy this assertion.
    await client.close();
    client = fixture.open();
    const selectedSession = await unlock(fixture, client);
    same(selectedSession.vault, newer.vault, 'restart must prefer the saved selection over the still-valid but outdated profile vault');
    same(await download(client, selectedSession.token), newBytes, 'restarted backup must come from the saved selection');
    const newPreview = await preview(fixture, client, backup);
    const newRestored = success<SessionResponse>(await client.api('POST', '/api/restore/confirm', { body: { restoreToken: newPreview.restoreToken } }));
    same(newRestored.vault, archived.vault, 'restore must replace the selected snapshot');
    assert.ok(newer.vault.entries.length > newRestored.vault.entries.length, 'restore must actually replace newer content');
    assert.ok(newRestored.safetyBackupPath, 'restore in the selected directory must report a safety file');
    const newHistory = newRestored.safetyBackupPath;
    assert.equal(dirname(newHistory), first);
    assert.match(basename(newHistory), /^before-restore-\d+-[a-f0-9-]+\.pvlt$/);
    same(await readFile(newHistory), newBytes, 'new safety copy must preserve the selected pre-restore ciphertext');
    same(await readFile(firstPath), backup, 'restore must write exact backup bytes in the selected directory');
    same(await readFile(fixture.originalPath), backup, 'restore must not touch the old vault');
    same(await readFile(historicalPath), beforeRestore, 'restore must not touch the old history');
    assert.deepEqual((await readdir(first)).sort(), [basename(newHistory), 'vault.pvlt'].sort());

    const second = join(fixture.root, 'second-location');
    const secondPath = join(second, 'vault.pvlt');
    const secondBody = migration(second, firstPath, newRestored.vault.revision);
    const secondResult = success<StorageLocationResponse>(await client.api('POST', '/api/storage-location', { token: newRestored.token, body: secondBody }));
    assert.deepEqual(secondResult, { previousStoragePath: firstPath, status: locked(secondPath) });
    await configured(fixture, second);
    same(await readFile(secondPath), backup, 'second migration must also preserve the exact ciphertext');
    same(await readFile(firstPath), backup, 'second migration must retain its previous vault');
    same(await readFile(newHistory), newBytes, 'second migration must retain its previous history');
    failure(await client.api('POST', '/api/storage-location', { token: newRestored.token, body: secondBody }), 401, 'LOCKED');
    await client.close();
    client = fixture.open();
    assert.deepEqual(success<VaultStatus>(await client.api('GET', '/api/status')), locked(secondPath));
    const finalSession = await unlock(fixture, client);
    success(await client.api('PUT', '/api/settings', {
      token: finalSession.token, body: { revision: finalSession.vault.revision, autoLockMinutes: 15 },
    }));
    assert.ok(!(await readFile(secondPath)).equals(backup), 'after a second restart only the latest selected file may be written');
    same(await download(client, finalSession.token), await readFile(secondPath), 'backup must follow the second migration');
    same(await readFile(firstPath), backup, 'later writes must leave the first target untouched');
    same(await readFile(fixture.originalPath), backup, 'later writes must leave the profile vault untouched');
    same(await readFile(newHistory), newBytes, 'later writes must leave first-target history untouched');
    same(await readFile(historicalPath), beforeRestore, 'later writes must leave profile history untouched');
    assert.deepEqual(await readdir(second), ['vault.pvlt']);
    await configured(fixture, second);
  });
});

test('already-open instances reject operations when their shared profile is migrated elsewhere', async () => {
  await withVault(async fixture => {
    const writer = fixture.open();
    const created = await create(writer);
    const observer = fixture.open();
    const observing = await unlock(fixture, observer);
    const source = await readFile(fixture.originalPath);
    const pending = await preview(fixture, observer, source);
    const first = join(fixture.root, 'other-instance-target');
    const firstPath = join(first, 'vault.pvlt');
    success<StorageLocationResponse>(await writer.api('POST', '/api/storage-location', {
      token: created.token, body: migration(first, fixture.originalPath, created.vault.revision),
    }));
    const routes: Array<[Method, string, unknown?]> = [
      ['GET', '/api/status'], ['GET', '/api/vault'], ['GET', '/api/backup'], ['POST', '/api/activity'],
      ['POST', '/api/create', { password: PASSWORD }], ['POST', '/api/unlock', { password: PASSWORD }],
      ['PUT', '/api/settings', { revision: observing.vault.revision, autoLockMinutes: 15 }],
      ['POST', '/api/restore/confirm', { restoreToken: pending.restoreToken }],
      ['POST', '/api/storage-location', migration(join(fixture.root, 'stale-instance-target'), fixture.originalPath, observing.vault.revision)],
    ];
    for (const [method, path, body] of routes) {
      failure(await observer.api(method, path, { token: observing.token, body }), 409, 'LOCATION_CHANGED');
    }
    await absent(join(fixture.root, 'stale-instance-target'));
    same(await readFile(fixture.originalPath), source, 'stale-instance requests must never write the retained old vault');
    same(await readFile(firstPath), source, 'stale-instance requests must not replace the selected vault');
    assert.deepEqual((await readdir(fixture.profile)).sort(), ['storage-location.json', 'vault.pvlt']);
    assert.deepEqual(await readdir(first), ['vault.pvlt']);
    await configured(fixture, first);

    // Also cover a change from an existing configuration, not just absent -> configured.
    const selectedObserver = fixture.open();
    const selectedSession = await unlock(fixture, selectedObserver);
    const writerSession = await unlock(fixture, writer);
    const second = join(fixture.root, 'other-instance-second');
    success<StorageLocationResponse>(await writer.api('POST', '/api/storage-location', {
      token: writerSession.token, body: migration(second, firstPath, writerSession.vault.revision),
    }));
    failure(await selectedObserver.api('GET', '/api/status', { token: selectedSession.token }), 409, 'LOCATION_CHANGED');
    failure(await selectedObserver.api('PUT', '/api/settings', {
      token: selectedSession.token, body: { revision: selectedSession.vault.revision, autoLockMinutes: 1 },
    }), 409, 'LOCATION_CHANGED');
    same(await readFile(firstPath), source, 'an observer of a previously selected directory must not keep writing there');
    same(await readFile(join(second, 'vault.pvlt')), source, 'a stale selected-directory observer must not write the new target');
    await configured(fixture, second);
  });
});

test('losing the selected vault while running locks the session and never creates a replacement', async () => {
  await withVault(async fixture => {
    const client = fixture.open();
    const created = await create(client);
    const original = await readFile(fixture.originalPath);
    const target = join(fixture.root, 'runtime-selected');
    success<StorageLocationResponse>(await client.api('POST', '/api/storage-location', {
      token: created.token, body: migration(target, fixture.originalPath, created.vault.revision),
    }));
    const session = await unlock(fixture, client);
    await rm(join(target, 'vault.pvlt'));
    failure(await client.api('GET', '/api/status', { token: session.token }), 503, 'LOCATION_UNAVAILABLE');
    failure(await client.api('POST', '/api/create', { body: { password: PASSWORD } }), 503, 'LOCATION_UNAVAILABLE');
    failure(await client.api('GET', '/api/vault', { token: session.token }), 503, 'LOCATION_UNAVAILABLE');
    assert.deepEqual(await readdir(target), []);
    same(await readFile(fixture.originalPath), original, 'missing selected files must not modify the retained original');
    await configured(fixture, target);
    await writeFile(join(target, 'vault.pvlt'), original, { flag: 'wx' });
    failure(await client.api('GET', '/api/vault', { token: session.token }), 401, 'LOCKED');
    same((await unlock(fixture, client)).vault, created.vault, 'recovered disk requires a fresh unlock');
  });
});

test('invalid or unavailable saved locations reject startup instead of falling back to the old vault', async t => {
  await withVault(async fixture => {
    const setup = fixture.open();
    await create(setup);
    const original = await readFile(fixture.originalPath);
    await setup.close();
    const missingDirectory = join(fixture.root, 'missing-selected-directory');
    const emptyDirectory = join(fixture.root, 'selected-without-vault');
    const nonFileDirectory = join(fixture.root, 'selected-with-vault-directory');
    await mkdir(emptyDirectory);
    await mkdir(join(nonFileDirectory, 'vault.pvlt'), { recursive: true });
    const cases: Array<[string, string, string]> = [
      ['malformed JSON', '{', 'CONFIG_INVALID'],
      ['unsupported config version', JSON.stringify({ version: 2, directory: fixture.profile }), 'CONFIG_INVALID'],
      ['relative saved path', JSON.stringify({ version: 1, directory: 'relative-vault' }), 'CONFIG_INVALID'],
      ['missing selected directory', JSON.stringify({ version: 1, directory: missingDirectory }), 'LOCATION_UNAVAILABLE'],
      ['missing selected vault', JSON.stringify({ version: 1, directory: emptyDirectory }), 'LOCATION_UNAVAILABLE'],
      ['selected vault is not a file', JSON.stringify({ version: 1, directory: nonFileDirectory }), 'LOCATION_UNAVAILABLE'],
    ];
    for (const [name, config, code] of cases) {
      await t.test(name, async () => {
        await writeFile(fixture.configPath, config, { flag: 'wx' });
        const broken = fixture.open();
        try {
          await assert.rejects(broken.ready(), (error: unknown) =>
            error instanceof VaultError && error.statusCode === 500 && error.code === code);
          same(await readFile(fixture.originalPath), original, 'startup failure must never change the available old vault');
          same(await readFile(fixture.configPath, 'utf8'), config, 'startup must not repair or silently reset the selection');
          assert.deepEqual((await readdir(fixture.profile)).sort(), ['storage-location.json', 'vault.pvlt']);
          await absent(missingDirectory);
          assert.deepEqual(await readdir(emptyDirectory), [], 'startup must not create a replacement vault');
          assert.deepEqual(await readdir(join(nonFileDirectory, 'vault.pvlt')), []);
        } finally {
          await broken.close();
          await rm(fixture.configPath);
        }
      });
    }
  });
});
