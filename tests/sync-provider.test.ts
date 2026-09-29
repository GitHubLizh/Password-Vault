import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSyncProvider } from './helpers/fake-sync-provider.js';
import { withVault, success } from './helpers/vault-fixture.js';
import type { VaultStatus } from '../shared/types.js';

test('fake provider: upload creates a remote version visible to list/version/download', async () => {
  const provider = new FakeSyncProvider();
  assert.deepEqual(await provider.listProfiles(), []);
  assert.equal(await provider.remoteVersion('work'), null);
  assert.equal(await provider.download('work'), null);

  const first = await provider.upload('work', 'envelope-a');
  assert.equal(await provider.remoteVersion('work'), first);
  assert.equal(await provider.download('work'), 'envelope-a');
  assert.deepEqual(await provider.listProfiles(), ['work']);

  const second = await provider.upload('work', 'envelope-b');
  assert.notEqual(second, first, 'a new upload must produce a new version');
  assert.equal(await provider.remoteVersion('work'), second);
  assert.equal(await provider.download('work'), 'envelope-b');
});

test('fake provider: the default profile is addressed by null, and removal empties it', async () => {
  const provider = new FakeSyncProvider();
  await provider.upload(null, 'root-envelope');
  await provider.upload('work', 'work-envelope');
  assert.deepEqual((await provider.listProfiles()).slice().sort((a, b) => (a ?? '') < (b ?? '') ? -1 : 1),
    [null, 'work']);

  provider.removeRemote('work');
  assert.equal(await provider.remoteVersion('work'), null);
  assert.deepEqual(await provider.listProfiles(), [null]);
});

test('fake provider: intercept runs before the call so tests can move the remote at an arbitrary point', async () => {
  const provider = new FakeSyncProvider();
  await provider.upload('work', 'envelope-1');
  const seen: string[] = [];
  provider.intercept = (method, profileId) => {
    seen.push(`${method}:${profileId ?? ''}`);
    if (method === 'remoteVersion' && profileId === 'work') provider.setRemote('work', 'envelope-2');
  };
  const versionBefore = await provider.remoteVersion('work');
  assert.equal(seen[0], 'remoteVersion:work');
  assert.equal(await provider.download('work'), 'envelope-2', 'intercepted change is observable in the same run');
  assert.notEqual(await provider.remoteVersion('work'), versionBefore);
});

test('injection seam: a configured provider stays untouched while no sync behaviour exists yet', async () => {
  const provider = new FakeSyncProvider();
  await withVault(async fixture => {
    const created = success<{ token: string; vault: { revision: number } }>(
      await fixture.api('POST', '/api/create', { body: { password: 'test-password-123' } }));
    assert.ok(created.token);
    await fixture.api('POST', '/api/entries', {
      token: created.token,
      body: {
        revision: created.vault.revision,
        entry: { type: 'account', name: 'github', username: 'u', address: 'https://github.com', port: '', password: 'p', apiKey: '', secret: '', notes: '' },
      },
    });
    const status = success<VaultStatus>(await fixture.api('GET', '/api/status', { token: created.token }));
    assert.equal(status.unlocked, true);
  }, { syncProvider: provider });
  assert.deepEqual(provider.calls, [], 'ticket 002 must not wire any sync behaviour into existing routes');
});
