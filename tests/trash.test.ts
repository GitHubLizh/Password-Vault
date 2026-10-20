import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshot } from '../server/validation.js';
import type { EntryInput, SessionResponse, VaultResponse } from '../shared/types.js';
import { failure, success, withVault } from './helpers/vault-fixture.js';

const PASSWORD = '回收站测试主密码-2026';
const DAY = 24 * 60 * 60 * 1000;

const entry = (name: string): EntryInput => ({
  type: 'account', name, username: 'tester', address: '', port: '', password: 'unit-secret', apiKey: '', secret: '', notes: '',
});

async function createVault(f: Parameters<Parameters<typeof withVault>[0]>[0]): Promise<SessionResponse> {
  return success<SessionResponse>(await f.api('POST', '/api/create', { body: { password: PASSWORD } }));
}

test('deleting moves an entry to the trash and restoring keeps its identity', () => withVault(async f => {
  const created = await createVault(f);
  const token = created.token;
  const saved = success<VaultResponse>(await f.api('POST', '/api/entries', { token, body: { entry: entry('站点A'), revision: created.vault.revision } }));
  const original = saved.vault.entries[0];
  const deleted = success<VaultResponse>(await f.api('DELETE', `/api/entries/${original.id}`, { token, body: { revision: saved.vault.revision } }));
  assert.equal(deleted.vault.entries.length, 0);
  assert.equal(deleted.vault.trash.length, 1);
  assert.equal(deleted.vault.trash[0].id, original.id);
  assert.equal(deleted.vault.trash[0].password, 'unit-secret');
  assert.ok(Number.isFinite(Date.parse(deleted.vault.trash[0].deletedAt)), 'trashed entry must carry a deletion timestamp');
  const restored = success<VaultResponse>(await f.api('POST', `/api/trash/${original.id}/restore`, { token, body: { revision: deleted.vault.revision } }));
  assert.equal(restored.vault.trash.length, 0);
  assert.equal(restored.vault.entries.length, 1);
  assert.equal(restored.vault.entries[0].id, original.id, 'restore keeps the original id');
  assert.equal(restored.vault.entries[0].createdAt, original.createdAt, 'restore keeps the creation time');
  assert.equal(restored.vault.entries[0].password, 'unit-secret');
  failure(await f.api('POST', `/api/trash/${original.id}/restore`, { token, body: { revision: restored.vault.revision } }), 404, 'NOT_FOUND');
}));

test('trash operations validate revision, confirmation and edit protection', () => withVault(async f => {
  const created = await createVault(f);
  const token = created.token;
  const saved = success<VaultResponse>(await f.api('POST', '/api/entries', { token, body: { entry: entry('站点B'), revision: created.vault.revision } }));
  const id = saved.vault.entries[0].id;
  const deleted = success<VaultResponse>(await f.api('DELETE', `/api/entries/${id}`, { token, body: { revision: saved.vault.revision } }));
  failure(await f.api('PUT', `/api/entries/${id}`, { token, body: { entry: entry('改名'), revision: deleted.vault.revision } }), 404, 'NOT_FOUND');
  failure(await f.api('POST', `/api/trash/${id}/restore`, { token, body: { revision: 999 } }), 409, 'REVISION_CONFLICT');
  failure(await f.api('DELETE', '/api/trash', { token, body: { revision: deleted.vault.revision } }), 400, 'INVALID_INPUT');
  failure(await f.api('DELETE', `/api/trash/${id}`, { token, body: { revision: 999 } }), 409, 'REVISION_CONFLICT');
  const destroyed = success<VaultResponse>(await f.api('DELETE', `/api/trash/${id}`, { token, body: { revision: deleted.vault.revision } }));
  assert.equal(destroyed.vault.trash.length, 0);
  failure(await f.api('DELETE', `/api/trash/${id}`, { token, body: { revision: destroyed.vault.revision } }), 404, 'NOT_FOUND');
  failure(await f.api('DELETE', '/api/trash', { token, body: { revision: destroyed.vault.revision, confirmed: true } }), 400, 'INVALID_INPUT');
}));

test('emptying the trash clears every entry at once', () => withVault(async f => {
  const created = await createVault(f);
  const token = created.token;
  let revision = created.vault.revision;
  for (const name of ['条目一', '条目二']) {
    const saved = success<VaultResponse>(await f.api('POST', '/api/entries', { token, body: { entry: entry(name), revision } }));
    revision = saved.vault.revision;
    const deleted = success<VaultResponse>(await f.api('DELETE', `/api/entries/${saved.vault.entries[0].id}`, { token, body: { revision } }));
    revision = deleted.vault.revision;
  }
  const emptied = success<VaultResponse>(await f.api('DELETE', '/api/trash', { token, body: { revision, confirmed: true } }));
  assert.equal(emptied.vault.trash.length, 0);
  assert.equal(emptied.vault.entries.length, 0);
}));

test('trash older than 30 days is purged on unlock and the purge persists', () => withVault(async f => {
  const created = await createVault(f);
  const token = created.token;
  const saved = success<VaultResponse>(await f.api('POST', '/api/entries', { token, body: { entry: entry('过期条目'), revision: created.vault.revision } }));
  const deleted = success<VaultResponse>(await f.api('DELETE', `/api/entries/${saved.vault.entries[0].id}`, { token, body: { revision: saved.vault.revision } }));
  assert.equal(deleted.vault.trash.length, 1);
  await f.api('POST', '/api/lock', { token, body: {} });
  f.advance(29 * DAY);
  await f.restart();
  const fresh = success<SessionResponse>(await f.api('POST', '/api/unlock', { body: { password: PASSWORD } }));
  assert.equal(fresh.vault.trash.length, 1, 'a 29-day-old entry is still within retention');
  await f.api('POST', '/api/lock', { token: fresh.token, body: {} });
  f.advance(2 * DAY);
  await f.restart();
  const purged = success<SessionResponse>(await f.api('POST', '/api/unlock', { body: { password: PASSWORD } }));
  assert.equal(purged.vault.trash.length, 0, 'a 31-day-old entry is purged on unlock');
  await f.api('POST', '/api/lock', { token: purged.token, body: {} });
  await f.restart();
  const again = success<SessionResponse>(await f.api('POST', '/api/unlock', { body: { password: PASSWORD } }));
  assert.equal(again.vault.trash.length, 0, 'the purge is written to disk, not just in memory');
}));

test('vault snapshots without a trash field load with an empty recycle bin', () => {
  const legacy = snapshot({ entries: [], settings: { autoLockMinutes: 5 }, revision: 1 });
  assert.deepEqual(legacy.trash, []);
  const entryId = '123e4567-e89b-42d3-a456-426614174000';
  const withTrash = snapshot({
    entries: [],
    trash: [{ ...entry('回收站条目'), id: entryId, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: '2026-01-02T00:00:00.000Z' }],
    settings: { autoLockMinutes: 5 }, revision: 2,
  });
  assert.equal(withTrash.trash.length, 1);
  assert.equal(withTrash.trash[0].deletedAt, '2026-01-02T00:00:00.000Z');
  assert.throws(() => snapshot({
    entries: [{ ...entry('冲突'), id: entryId, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    trash: [{ ...entry('冲突'), id: entryId, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: '2026-01-02T00:00:00.000Z' }],
    settings: { autoLockMinutes: 5 }, revision: 3,
  }), /编号不正确或重复/);
});
