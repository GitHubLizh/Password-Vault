import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { MAX_PROFILES } from '../server/profile-name.js';
import type { DeleteProfileResponse, ProfilesResponse, RestorePreview, SessionResponse, StorageLocationResponse, VaultResponse, VaultStatus } from '../shared/types.js';
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

test('the default profile can be renamed and the name survives restarts', async () => {
  await withVault(async fixture => {
    const session = success<SessionResponse>(await fixture.api('POST', '/api/create', { body: { password: PASSWORD } }));
    const renamed = success<ProfilesResponse>(await fixture.api('POST', '/api/profiles/default-name', { token: session.token, body: { name: '个人' } }));
    assert.deepEqual(renamed.profiles, [{ id: null, name: '个人', isDefault: true }]);
    assert.deepEqual((await readdir(fixture.directory)).sort(), ['profiles.json', 'vault.pvlt']);
    await fixture.restart();
    assert.deepEqual(success<ProfilesResponse>(await fixture.api('GET', '/api/profiles')).profiles, [
      { id: null, name: '个人', isDefault: true },
    ]);
    const reopened = success<SessionResponse>(await unlockAttempt(fixture, { password: PASSWORD }));
    assert.ok(reopened.token, 'renaming must not affect unlocking');
  });
});

test('renaming the default profile is refused from another profile and for invalid names', async () => {
  await withVault(async fixture => {
    await fixture.api('POST', '/api/create', { body: { password: PASSWORD } });
    const work = await enter(fixture, '工作');
    failure(await fixture.api('POST', '/api/profiles/default-name', { token: work.token, body: { name: '个人' } }), 400, 'NOT_DEFAULT_PROFILE');
    failure(await fixture.api('POST', '/api/profiles/default-name', { body: { name: '个人' } }), 401, 'LOCKED');
    const session = success<SessionResponse>(await fixture.api('POST', '/api/unlock', { body: { password: PASSWORD } }));
    for (const name of ['', '   ', 'x'.repeat(33), '<坏名字>', '../逃逸']) {
      failure(await fixture.api('POST', '/api/profiles/default-name', { token: session.token, body: { name } }), 400, 'INVALID_PROFILE_NAME');
    }
    assert.deepEqual(success<ProfilesResponse>(await fixture.api('GET', '/api/profiles')).profiles, [
      { id: null, name: '默认', isDefault: true },
      { id: '工作', name: '工作', isDefault: false },
    ]);
  });
});

test('a damaged display-name config falls back to 默认 without blocking unlock', async () => {
  await withVault(async fixture => {
    const session = success<SessionResponse>(await fixture.api('POST', '/api/create', { body: { password: PASSWORD } }));
    success<ProfilesResponse>(await fixture.api('POST', '/api/profiles/default-name', { token: session.token, body: { name: '个人' } }));
    const configPath = join(fixture.directory, 'profiles.json');
    for (const damaged of ['{', JSON.stringify({ version: 2, defaultName: '个人' }), JSON.stringify({ version: 1, defaultName: '<非法但已落盘>' })]) {
      await writeFile(configPath, damaged, 'utf8');
      assert.deepEqual(success<ProfilesResponse>(await fixture.api('GET', '/api/profiles')).profiles, [
        { id: null, name: '默认', isDefault: true },
      ], `config ${damaged} must fall back to the built-in name`);
      success<SessionResponse>(await unlockAttempt(fixture, { password: PASSWORD }));
    }
  });
});

test('deleting an unlocked profile keeps a decryptable copy and leaves the default vault alone', async () => {
  await withVault(async fixture => {
    const initial = success<SessionResponse>(await fixture.api('POST', '/api/create', { body: { password: PASSWORD } }));
    await addEntry(fixture, initial, '默认档的条目');
    const defaultSource = await readVault(fixture.storagePath);
    const work = await enter(fixture, '工作');
    const filled = await addEntry(fixture, work, '工作档的条目');
    const body = { name: '工作', confirmed: true, revision: filled.vault.revision };

    failure(await fixture.api('DELETE', '/api/profiles', { body }), 401, 'LOCKED');
    failure(await fixture.api('DELETE', '/api/profiles', { token: filled.token, body: { ...body, confirmed: undefined } }), 400, 'INVALID_INPUT');
    failure(await fixture.api('DELETE', '/api/profiles', { token: filled.token, body: { ...body, name: '别的名字' } }), 400, 'INVALID_INPUT');
    failure(await fixture.api('DELETE', '/api/profiles', { token: filled.token, body: { ...body, profile: '默认' } }), 400, 'INVALID_INPUT');
    assert.equal(await readVault(fixture.storagePath), defaultSource, 'a refused delete must not touch anything');

    const deleted = success<DeleteProfileResponse>(await fixture.api('DELETE', '/api/profiles', { token: filled.token, body }));
    assert.match(deleted.safetyBackupPath, /before-delete-.*\.pvlt$/);
    assert.deepEqual(success<ProfilesResponse>(await fixture.api('GET', '/api/profiles')).profiles, [
      { id: null, name: '默认', isDefault: true },
    ]);
    assert.equal(await readVault(fixture.storagePath), defaultSource, 'deleting a profile must not touch the default vault');
    assert.deepEqual(await readdir(join(fixture.directory, '工作')), []);
    failure(await fixture.api('GET', '/api/vault', { token: filled.token }), 401, 'LOCKED');

    const preview = success<RestorePreview>(await fixture.api('POST', '/api/restore/preview', {
      body: { backup: await readFile(deleted.safetyBackupPath, 'utf8'), password: OTHER },
    }));
    assert.equal(preview.entryCount, 1, 'the safety copy must still decrypt with the deleted profile password');
    success(await fixture.api('POST', '/api/restore/cancel', { body: { restoreToken: preview.restoreToken } }));
  });
});

test('the default profile cannot be deleted', async () => {
  await withVault(async fixture => {
    const session = success<SessionResponse>(await fixture.api('POST', '/api/create', { body: { password: PASSWORD } }));
    failure(await fixture.api('DELETE', '/api/profiles', {
      token: session.token, body: { name: '默认', confirmed: true, revision: session.vault.revision },
    }), 400, 'DEFAULT_PROFILE_UNDELETABLE');
    assert.ok((await readVault(fixture.storagePath)).length > 0);
  });
});

test('deleting a profile leaves unrelated files in its directory alone', async () => {
  await withVault(async fixture => {
    await fixture.api('POST', '/api/create', { body: { password: PASSWORD } });
    const work = await enter(fixture, '工作');
    await writeFile(join(fixture.directory, '工作', '我的笔记.txt'), '保留', 'utf8');
    success<DeleteProfileResponse>(await fixture.api('DELETE', '/api/profiles', {
      token: work.token, body: { name: '工作', confirmed: true, revision: work.vault.revision },
    }));
    assert.deepEqual(await readdir(join(fixture.directory, '工作')), ['我的笔记.txt']);
  });
});

test('backup download is named after the current profile', async () => {
  await withVault(async fixture => {
    const initial = success<SessionResponse>(await fixture.api('POST', '/api/create', { body: { password: PASSWORD } }));
    const legacy = await fixture.api('GET', '/api/backup', { token: initial.token });
    assert.equal(String(legacy.headers['content-disposition']), 'attachment; filename="password-vault.pvlt"',
      'the default profile must keep the historic filename');

    const work = await enter(fixture, '工作');
    const response = await fixture.api('GET', '/api/backup', { token: work.token });
    assert.equal(response.statusCode, 200);
    const header = String(response.headers['content-disposition']);
    assert.match(header, /filename\*=UTF-8''password-vault-%E5%B7%A5%E4%BD%9C\.pvlt/, 'the UTF-8 form must carry the real name');
    assert.match(header, /filename="password-vault-__\.pvlt"/, 'the ASCII fallback must stay header-safe');
  });
});

test('migration moves every profile together and keeps the abandoned store intact', async () => {
  await withVault(async fixture => {
    const initial = success<SessionResponse>(await fixture.api('POST', '/api/create', { body: { password: PASSWORD } }));
    await addEntry(fixture, initial, '默认档的条目');
    const defaultSource = await readVault(fixture.storagePath);
    const work = await enter(fixture, '工作');
    const filled = await addEntry(fixture, work, '工作档的条目');
    const workSource = await readVault(await profileVault(fixture, '工作'));
    const target = join(dirname(fixture.directory), `${basename(fixture.directory)}-moved`);

    success<StorageLocationResponse>(await fixture.api('POST', '/api/storage-location', {
      token: filled.token, body: { directory: target, storagePath: fixture.storagePath, revision: filled.vault.revision, confirmed: true },
    }));
    await fixture.restart();
    assert.deepEqual((await readdir(target)).sort(), ['vault.pvlt', '工作']);
    assert.equal(await readVault(join(target, 'vault.pvlt')), defaultSource, 'the default vault must arrive byte-identical');
    assert.equal(await readVault(join(target, '工作', 'vault.pvlt')), workSource, 'the profile vault must arrive byte-identical');
    assert.equal(await readVault(fixture.storagePath), defaultSource, 'migration copies rather than moves');
    const reopened = success<SessionResponse>(await unlockAttempt(fixture, { profile: '工作', password: OTHER }));
    assert.deepEqual(reopened.vault.entries.map(entryItem => entryItem.name), ['工作档的条目']);
  });
});

test('migration refuses a target already holding a profile vault and leaves everything alone', async () => {
  await withVault(async fixture => {
    await fixture.api('POST', '/api/create', { body: { password: PASSWORD } });
    const work = await enter(fixture, '工作');
    const filled = await addEntry(fixture, work, '工作档的条目');
    const defaultSource = await readVault(fixture.storagePath);
    const workSource = await readVault(await profileVault(fixture, '工作'));
    const target = join(dirname(fixture.directory), `${basename(fixture.directory)}-occupied`);
    await mkdir(join(target, '工作'), { recursive: true });
    await writeFile(join(target, '工作', 'vault.pvlt'), '{"format":"other"}', 'utf8');

    failure(await fixture.api('POST', '/api/storage-location', {
      token: filled.token, body: { directory: target, storagePath: fixture.storagePath, revision: filled.vault.revision, confirmed: true },
    }), 409, 'TARGET_EXISTS');
    assert.deepEqual(await readdir(target), ['工作'], 'a refused migration must create nothing in the target');
    assert.equal(await readVault(join(target, '工作', 'vault.pvlt')), '{"format":"other"}');
    assert.equal(await readVault(fixture.storagePath), defaultSource);
    assert.equal(await readVault(await profileVault(fixture, '工作')), workSource);
    assert.equal(success<VaultStatus>(await fixture.api('GET', '/api/status', { token: filled.token })).storagePath,
      await profileVault(fixture, '工作'), 'the session must still point at the original store');
  });
});

test('a pending restore cannot be redirected into another profile', async () => {
  await withVault(async fixture => {
    const initial = success<SessionResponse>(await fixture.api('POST', '/api/create', { body: { password: PASSWORD } }));
    await addEntry(fixture, initial, '默认档的条目');
    const defaultBefore = await readVault(fixture.storagePath);
    const work = await enter(fixture, '工作');
    const short = success<VaultResponse>(await fixture.api('PUT', '/api/settings', {
      token: work.token, body: { autoLockMinutes: 1, revision: work.vault.revision },
    }));
    const filled = await addEntry(fixture, { ...work, vault: short.vault }, '工作档的条目');
    const backup = String((await fixture.api('GET', '/api/backup', { token: filled.token })).body);

    // A session keeps the expiry it was created with, so re-unlock to get the 1-minute window.
    const session = success<SessionResponse>(await unlockAttempt(fixture, { profile: '工作', password: OTHER }));
    fixture.advance(50000);
    const preview = success<RestorePreview>(await fixture.api('POST', '/api/restore/preview', { token: session.token, body: { backup, password: OTHER } }));
    assert.equal(preview.willReplace, true);
    // Let the session expire while the preview is still valid: the write target must not silently
    // fall back to the default profile.
    fixture.advance(15000);
    failure(await fixture.api('POST', '/api/restore/confirm', { body: { restoreToken: preview.restoreToken } }), 409, 'RESTORE_STALE');
    assert.equal(await readVault(fixture.storagePath), defaultBefore, 'a stale restore must not touch the default vault');

    const reopened = success<SessionResponse>(await unlockAttempt(fixture, { profile: '工作', password: OTHER }));
    assert.deepEqual(reopened.vault.entries.map(entryItem => entryItem.name), ['工作档的条目']);
    const retried = success<RestorePreview>(await fixture.api('POST', '/api/restore/preview', { token: reopened.token, body: { backup, password: OTHER } }));
    const restored = success<SessionResponse>(await fixture.api('POST', '/api/restore/confirm', { body: { restoreToken: retried.restoreToken } }));
    assert.deepEqual(restored.vault.entries.map(entryItem => entryItem.name), ['工作档的条目']);
    assert.equal(await readVault(fixture.storagePath), defaultBefore, 'restoring into a profile must not touch the default vault');
    assert.equal(success<ProfilesResponse>(await fixture.api('GET', '/api/profiles')).profiles.length, 2);
  });
});
