import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { ProfilesResponse, SessionResponse, VaultStatus } from '../shared/types.js';
import { success, withVault } from './helpers/vault-fixture.js';

const PASSWORD = '  本地测试-主密码-e\u0301  ';

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
