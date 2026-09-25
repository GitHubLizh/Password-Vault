import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { MAX_PROFILES } from '../server/profile-name.js';
import type { ProfilesResponse, SessionResponse, VaultResponse, VaultStatus } from '../shared/types.js';
import { failure, success, withVault, type Fixture } from './helpers/vault-fixture.js';

const PASSWORD = '  本地测试-主密码-e\u0301  ';
const OTHER = '另一个身份档-口令-2026';

function created(response: SessionResponse): SessionResponse {
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(response.token), 'create must return an opaque session token');
  assert.deepEqual(response.vault.entries, []);
  return response;
}

async function enter(fixture: Fixture, name: string, password = OTHER): Promise<SessionResponse> {
  return created(success<SessionResponse>(await attempt(fixture, { name, password })));
}

async function attempt(fixture: Fixture, body: unknown): Promise<LightMyRequestResponse> {
  fixture.advance(1000);
  return fixture.api('POST', '/api/profiles', { body });
}

async function unlockAttempt(fixture: Fixture, body: Record<string, unknown>): Promise<LightMyRequestResponse> {
  fixture.advance(1000);
  return fixture.api('POST', '/api/unlock', { body });
}

async function unlock(fixture: Fixture, profile: string | null, password: string): Promise<SessionResponse> {
  return success<SessionResponse>(await unlockAttempt(fixture, { profile, password }));
}

async function addEntry(fixture: Fixture, session: SessionResponse, name: string): Promise<SessionResponse> {
  const saved = success<VaultResponse>(await fixture.api('POST', '/api/entries', {
    token: session.token,
    body: { revision: session.vault.revision, entry: { type: 'account', name, username: '', address: '', port: '', password: 'x', apiKey: '', secret: '', notes: '' } },
  }));
  return { ...session, vault: saved.vault, expiresAt: saved.expiresAt };
}

async function readVault(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function profileVault(fixture: Fixture, name: string): Promise<string> {
  return join(fixture.directory, name, 'vault.pvlt');
}

test('profile list reports the default profile only when its vault exists', async () => {
  await withVault(async fixture => {
    assert.deepEqual(success<ProfilesResponse>(await fixture.api('GET', '/api/profiles')).profiles, []);

    await fixture.api('POST', '/api/create', { body: { password: PASSWORD } });
    assert.deepEqual(success<ProfilesResponse>(await fixture.api('GET', '/api/profiles')).profiles, [
      { id: null, name: '默认', isDefault: true },
    ]);
  });
});

test('profile list is readable while locked and exposes no entry metadata', async () => {
  await withVault(async fixture => {
    const session = success<SessionResponse>(await fixture.api('POST', '/api/create', { body: { password: PASSWORD } }));
    await fixture.api('POST', '/api/entries', {
      token: session.token,
      body: { revision: session.vault.revision, entry: { type: 'account', name: '绝密的条目名', username: 'secret-user', address: 'https://secret.invalid', port: '', password: 'secret-password', apiKey: '', secret: '', notes: '' } },
    });
    await fixture.api('POST', '/api/lock', { token: session.token });

    for (const token of [undefined, session.token]) {
      const profiles = success<ProfilesResponse>(await fixture.api('GET', '/api/profiles', { token })).profiles;
      assert.equal(profiles.length, 1);
      assert.deepEqual(Object.keys(profiles[0]).sort(), ['id', 'isDefault', 'name']);
      assert.ok(!JSON.stringify(profiles).includes('绝密的条目名'), 'profile list must leak no entry name');
      assert.ok(!JSON.stringify(profiles).includes('secret'), 'profile list must leak no credential');
    }
  });
});

test('profile list discovers nested vaults, survives restart and keeps the default unlockable', async () => {
  await withVault(async fixture => {
    await fixture.api('POST', '/api/create', { body: { password: PASSWORD } });
    await mkdir(join(fixture.directory, 'beta'));
    await writeFile(join(fixture.directory, 'beta', 'vault.pvlt'), '{"format":"local-password-vault"}', 'utf8');
    await mkdir(join(fixture.directory, 'alpha'));
    await writeFile(join(fixture.directory, 'alpha', 'vault.pvlt'), '{"format":"local-password-vault"}', 'utf8');
    await fixture.restart();

    assert.deepEqual(success<ProfilesResponse>(await fixture.api('GET', '/api/profiles')).profiles, [
      { id: null, name: '默认', isDefault: true },
      { id: 'alpha', name: 'alpha', isDefault: false },
      { id: 'beta', name: 'beta', isDefault: false },
    ]);

    const reopened = success<SessionResponse>(await fixture.api('POST', '/api/unlock', { body: { password: PASSWORD } }));
    assert.deepEqual(reopened.vault.entries, []);
  });
});

test('stray files, empty folders and non-file vaults are never reported as profiles', async () => {
  await withVault(async fixture => {
    await fixture.api('POST', '/api/create', { body: { password: PASSWORD } });
    await writeFile(join(fixture.directory, '杂物.txt'), 'not a vault', 'utf8');
    await mkdir(join(fixture.directory, '空目录'), { recursive: true });
    await mkdir(join(fixture.directory, '伪装'), { recursive: true });
    await mkdir(join(fixture.directory, '伪装', 'vault.pvlt'));
    await fixture.restart();

    assert.deepEqual(success<ProfilesResponse>(await fixture.api('GET', '/api/profiles')).profiles, [
      { id: null, name: '默认', isDefault: true },
    ]);
  });
});

test('status shape is untouched by the profile list', async () => {
  await withVault(async fixture => {
    await fixture.api('POST', '/api/create', { body: { password: PASSWORD } });
    await mkdir(join(fixture.directory, 'alpha'));
    await writeFile(join(fixture.directory, 'alpha', 'vault.pvlt'), '{}', 'utf8');
    const status = success<VaultStatus>(await fixture.api('GET', '/api/status'));
    assert.deepEqual(Object.keys(status).sort(), ['autoLockMinutes', 'exists', 'expiresAt', 'revision', 'storagePath', 'unlocked']);
    assert.equal(status.exists, true);
    assert.equal(status.storagePath, fixture.storagePath);
  });
});

test('a profile can be created and entered while nothing is unlocked', async () => {
  await withVault(async fixture => {
    const work = await enter(fixture, '工作');
    assert.deepEqual(work.vault.entries, [], 'a new profile starts empty');
    assert.deepEqual((await readdir(join(fixture.directory, '工作'))).sort(), ['vault.pvlt']);
    assert.deepEqual(success<ProfilesResponse>(await fixture.api('GET', '/api/profiles')).profiles, [
      { id: '工作', name: '工作', isDefault: false },
    ]);
    const stray = (await readdir(fixture.directory)).filter(name => name !== '工作');
    assert.deepEqual(stray, [], 'creating a profile must not leave a stray default vault behind');
  });
});

test('creating a profile leaves the default vault byte-identical and keeps contents apart', async () => {
  await withVault(async fixture => {
    const initial = success<SessionResponse>(await fixture.api('POST', '/api/create', { body: { password: PASSWORD } }));
    await addEntry(fixture, initial, '默认档的条目');
    const before = await readVault(fixture.storagePath);

    const work = await enter(fixture, '工作');
    assert.equal(await readVault(fixture.storagePath), before, 'profile creation must not touch the default vault');
    const filled = await addEntry(fixture, work, '工作档的条目');
    assert.deepEqual(filled.vault.entries.map(entry => entry.name), ['工作档的条目']);
    assert.ok(!(await readVault(fixture.storagePath)).includes('工作档的条目'), 'the new entry must not reach the default vault');
    assert.ok(!(await readVault(await profileVault(fixture, '工作'))).includes('默认档的条目'), 'the default entry must not reach the new profile');
    assert.equal(success<VaultStatus>(await fixture.api('GET', '/api/status', { token: work.token })).storagePath,
      await profileVault(fixture, '工作'), 'an active session must report its own profile path');
  });
});

test('entering a new profile revokes the previous session', async () => {
  await withVault(async fixture => {
    const initial = success<SessionResponse>(await fixture.api('POST', '/api/create', { body: { password: PASSWORD } }));
    const work = await enter(fixture, '工作');
    failure(await fixture.api('GET', '/api/vault', { token: initial.token }), 401, 'LOCKED');
    success<VaultResponse>(await fixture.api('GET', '/api/vault', { token: work.token }));
  });
});

test('invalid profile names are rejected without creating anything on disk', async () => {
  await withVault(async fixture => {
    const before = await readdir(fixture.directory);
    for (const name of ['', '   ', 'a/b', 'a\\b', '..', '../逃逸', '带\x00控制符', '<尖括号>', 'con', 'CON', 'lpt3.txt', '结尾句点.', 'x'.repeat(33), 42, null]) {
      failure(await attempt(fixture, { name, password: OTHER }), 400, 'INVALID_PROFILE_NAME');
    }
    assert.deepEqual(await readdir(fixture.directory), before, 'rejected names must create nothing');
  });
});

test('unlocking selects the requested profile and rejects unknown or unsafe ones', async () => {
  await withVault(async fixture => {
    const initial = success<SessionResponse>(await fixture.api('POST', '/api/create', { body: { password: PASSWORD } }));
    await addEntry(fixture, initial, '默认档的条目');
    const work = await enter(fixture, '工作');
    await addEntry(fixture, work, '工作档的条目');
    await fixture.api('POST', '/api/lock', { token: work.token });

    const reopened = await unlock(fixture, '工作', OTHER);
    assert.deepEqual(reopened.vault.entries.map(entry => entry.name), ['工作档的条目']);
    assert.equal(success<VaultStatus>(await fixture.api('GET', '/api/status', { token: reopened.token })).storagePath,
      await profileVault(fixture, '工作'), 'an active session must report its own profile path');

    failure(await unlockAttempt(fixture, { profile: '没有这个档', password: OTHER }), 404, 'PROFILE_NOT_FOUND');
    failure(await unlockAttempt(fixture, { profile: '../../../etc', password: OTHER }), 400, 'INVALID_PROFILE_NAME');
    await mkdir(join(fixture.directory, '空目录'), { recursive: true });
    failure(await unlockAttempt(fixture, { profile: '空目录', password: OTHER }), 404, 'PROFILE_NOT_FOUND');

    // A profile password must not open the default vault, and vice versa.
    failure(await unlockAttempt(fixture, { password: OTHER }), 400, 'DECRYPT_FAILED');
    failure(await unlockAttempt(fixture, { profile: '工作', password: PASSWORD }), 400, 'DECRYPT_FAILED');

    const backToDefault = await unlock(fixture, null, PASSWORD);
    assert.deepEqual(backToDefault.vault.entries.map(entry => entry.name), ['默认档的条目']);
    failure(await fixture.api('GET', '/api/vault', { token: reopened.token }), 401, 'LOCKED');
  });
});

test('session endpoints refuse a caller-selected profile without touching the other vault', async () => {
  await withVault(async fixture => {
    const initial = success<SessionResponse>(await fixture.api('POST', '/api/create', { body: { password: PASSWORD } }));
    await addEntry(fixture, initial, '默认档的条目');
    const defaultSource = await readVault(fixture.storagePath);
    const work = await enter(fixture, '工作');
    const filled = await addEntry(fixture, work, '工作档的条目');
    const id = filled.vault.entries[0].id;
    const entry = { type: 'account' as const, name: '篡改尝试', username: '', address: '', port: '', password: 'y', apiKey: '', secret: '', notes: '' };
    const revision = filled.vault.revision;

    const attempts: [string, 'POST' | 'PUT' | 'DELETE', string, Record<string, unknown>][] = [
      ['新增条目', 'POST', '/api/entries', { entry, revision, profile: null }],
      ['编辑条目', 'PUT', `/api/entries/${id}`, { entry, revision, profile: '默认' }],
      ['删除条目', 'DELETE', `/api/entries/${id}`, { revision, profile: '默认' }],
      ['保存设置', 'PUT', '/api/settings', { autoLockMinutes: 15, revision, profile: '默认' }],
      ['修改主密码', 'POST', '/api/master-password', { currentPassword: OTHER, newPassword: '新的身份档口令-2026', confirmPassword: '新的身份档口令-2026', revision, profile: '默认' }],
      ['迁移存储', 'POST', '/api/storage-location', { directory: fixture.directory, storagePath: fixture.storagePath, revision, confirmed: true, profile: '默认' }],
    ];
    for (const [label, method, path, body] of attempts) {
      failure(await fixture.api(method, path, { token: work.token, body }), 400, 'INVALID_INPUT');
      assert.equal(await readVault(fixture.storagePath), defaultSource, `${label} must not touch the default vault`);
    }
    assert.deepEqual(success<VaultResponse>(await fixture.api('GET', '/api/vault', { token: work.token })).vault.entries
      .map(entryItem => entryItem.name), ['工作档的条目']);
  });
});

test('wrong-password attempts are budgeted per profile', async () => {
  await withVault(async fixture => {
    await fixture.api('POST', '/api/create', { body: { password: PASSWORD } });
    const work = await enter(fixture, '工作');
    await fixture.api('POST', '/api/lock', { token: work.token });

    failure(await unlockAttempt(fixture, { profile: '工作', password: '错的口令-2026-abcd' }), 400, 'DECRYPT_FAILED');
    // The default profile's budget was untouched by that attempt, so it may be used right away.
    const defaultSession = success<SessionResponse>(await fixture.api('POST', '/api/unlock', { body: { password: PASSWORD } }));
    assert.ok(defaultSession.token);
    // The profile that just failed is still cooling down.
    failure(await fixture.api('POST', '/api/unlock', { body: { profile: '工作', password: OTHER } }), 429, 'TRY_LATER');
  });
});

test('profile names collide case-insensitively and the profile count is capped', async () => {
  await withVault(async fixture => {
    await enter(fixture, '工作');
    failure(await attempt(fixture, { name: '工作', password: OTHER }), 409, 'PROFILE_EXISTS');
    const alpha = await enter(fixture, 'Alpha');
    failure(await attempt(fixture, { name: 'alpha', password: OTHER }), 409, 'PROFILE_EXISTS');
    failure(await attempt(fixture, { name: ' ALPHA ', password: OTHER }), 409, 'PROFILE_EXISTS');

    let count = success<ProfilesResponse>(await fixture.api('GET', '/api/profiles')).profiles.length;
    let last = alpha;
    while (count < MAX_PROFILES) {
      last = await enter(fixture, `档${count}`);
      count++;
    }
    assert.equal(success<ProfilesResponse>(await fixture.api('GET', '/api/profiles')).profiles.length, MAX_PROFILES);
    failure(await attempt(fixture, { name: '超出上限', password: OTHER }), 400, 'PROFILE_LIMIT');
    assert.equal(success<ProfilesResponse>(await fixture.api('GET', '/api/profiles')).profiles.length, MAX_PROFILES);
    success<VaultResponse>(await fixture.api('GET', '/api/vault', { token: last.token }));
    failure(await fixture.api('GET', '/api/vault', { token: alpha.token }), 401, 'LOCKED');
  });
});
