import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSnapshots } from '../shared/merge.js';
import type { VaultEntry, VaultSnapshot } from '../shared/types.js';

function ent(id: string, password = 'p', updatedAt = '2026-01-01T00:00:00.000Z'): VaultEntry {
  return {
    type: 'account', name: id, username: 'u', address: '', port: '',
    password, apiKey: '', secret: '', notes: '',
    id, createdAt: '2025-01-01T00:00:00.000Z', updatedAt,
  };
}

function snap(entries: VaultEntry[], minutes: VaultSnapshot['settings']['autoLockMinutes'] = 5, revision = 1): VaultSnapshot {
  return { entries, settings: { autoLockMinutes: minutes }, revision };
}

const a = ent('a');
const b = ent('b');
const c = ent('c');
const a2 = ent('a', 'changed');
const b2 = ent('b', 'changed');
const d = ent('d');
const e = ent('e');

interface MergeCase {
  name: string;
  base: VaultSnapshot;
  local: VaultSnapshot;
  remote: VaultSnapshot;
  merged?: VaultEntry[];
  conflicts?: { id: string; local: VaultEntry | null; remote: VaultEntry | null }[];
}

const cases: MergeCase[] = [
  {
    name: 'no divergence: both sides identical',
    base: snap([a, b]), local: snap([a, b]), remote: snap([a, b]),
    merged: [a, b],
  },
  {
    name: 'local-only add / modify / delete each taken from local',
    base: snap([a, b, c]), local: snap([a2, c]), remote: snap([a, b, c]),
    merged: [a2, c],
  },
  {
    name: 'remote-only add / modify / delete each taken from remote',
    base: snap([a, b, c]), local: snap([a, b, c]), remote: snap([a, b2, d]),
    merged: [a, b2, d],
  },
  {
    name: 'disjoint modifications auto-merge from both sides',
    base: snap([a, b]), local: snap([a2, b]), remote: snap([a, b2]),
    merged: [a2, b2],
  },
  {
    name: 'same entry modified on both sides is a conflict',
    base: snap([a]), local: snap([a2]), remote: snap([ent('a', 'other')]),
    conflicts: [{ id: 'a', local: a2, remote: ent('a', 'other') }],
  },
  {
    name: 'local delete vs remote modify conflicts with a null local side',
    base: snap([a, b]), local: snap([b]), remote: snap([a2, b]),
    conflicts: [{ id: 'a', local: null, remote: a2 }],
  },
  {
    name: 'delete vs delete is not a conflict',
    base: snap([a, b]), local: snap([b]), remote: snap([b]),
    merged: [b],
  },
  {
    name: 'independent adds from both sides are kept, local order first then remote-only adds',
    base: snap([]), local: snap([d]), remote: snap([e]),
    merged: [d, e],
  },
  {
    name: 'empty on both sides',
    base: snap([]), local: snap([]), remote: snap([]),
    merged: [],
  },
  {
    name: 'remote emptied entirely while local untouched',
    base: snap([a, b]), local: snap([a, b]), remote: snap([]),
    merged: [],
  },
];

for (const testCase of cases) {
  test(`merge: ${testCase.name}`, () => {
    const outcome = mergeSnapshots(testCase.base, testCase.local, testCase.remote);
    if (testCase.merged) {
      assert.equal(outcome.status, 'merged', `expected merged, got ${outcome.status}`);
      if (outcome.status === 'merged') assert.deepEqual(outcome.vault.entries, testCase.merged);
    } else {
      assert.equal(outcome.status, 'conflicts');
      if (outcome.status === 'conflicts') {
        assert.deepEqual(outcome.conflicts, testCase.conflicts);
      }
    }
  });
}

test('merge: merged revision exceeds both inputs deterministically', () => {
  const outcome = mergeSnapshots(snap([a], 5, 3), snap([a2], 5, 7), snap([a], 5, 5));
  assert.equal(outcome.status, 'merged');
  if (outcome.status === 'merged') assert.equal(outcome.vault.revision, 8);
});

test('merge: settings follow the side that changed; both changed favours local', () => {
  // Reason for local-wins: the device that detected divergence is the one the user is
  // actively unlocking, and autoLockMinutes is a session habit, not credentials data.
  assert.deepEqual(mergeSnapshots(snap([a], 5), snap([a], 5), snap([a], 15)),
    { status: 'merged', vault: snap([a], 15, 2) });
  assert.deepEqual(mergeSnapshots(snap([a], 5), snap([a], 1), snap([a], 15)),
    { status: 'merged', vault: snap([a], 1, 2) });
});

test('merge: unresolved conflicts block output, complete decisions resolve it', () => {
  const base = snap([a, b]);
  const local = snap([a2, b2]);
  const remote = snap([ent('a', 'other'), ent('b', 'other')]);
  const conflicted = mergeSnapshots(base, local, remote);
  assert.equal(conflicted.status, 'conflicts');
  if (conflicted.status === 'conflicts') {
    assert.deepEqual(conflicted.conflicts.map(item => item.id).sort(), ['a', 'b']);
    const partial = mergeSnapshots(base, local, remote, [{ id: 'a', choice: 'remote' }]);
    assert.equal(partial.status, 'conflicts', 'leaving b undecided must not emit a vault');
    const full = mergeSnapshots(base, local, remote, [
      { id: 'a', choice: 'remote' },
      { id: 'b', choice: 'manual', entry: ent('b', 'handmade') },
    ]);
    assert.equal(full.status, 'merged');
    if (full.status === 'merged') {
      assert.deepEqual(full.vault.entries, [ent('a', 'other'), ent('b', 'handmade')]);
    }
  }
});

test('merge: choosing local or remote for a modify-vs-delete conflict', () => {
  const base = snap([a]);
  const local = snap([]);
  const remote = snap([a2]);
  assert.deepEqual(mergeSnapshots(base, local, remote, [{ id: 'a', choice: 'remote' }]),
    { status: 'merged', vault: snap([a2], 5, 2) });
  assert.deepEqual(mergeSnapshots(base, local, remote, [{ id: 'a', choice: 'local' }]),
    { status: 'merged', vault: snap([], 5, 2) });
});

test('merge: manual decision without an entry leaves the conflict unresolved', () => {
  const base = snap([a]);
  const outcome = mergeSnapshots(base, snap([a2]), snap([ent('a', 'other')]),
    [{ id: 'a', choice: 'manual' } as unknown as { id: string; choice: 'manual'; entry: VaultEntry }]);
  assert.equal(outcome.status, 'conflicts');
});

test('merge: clock skew between devices never changes the outcome', () => {
  // A newest-timestamp-wins strategy would silently pick different winners in these two runs;
  // content-only three-way merge must report a conflict in both directions of clock skew.
  const early = '2025-12-31T00:00:00.000Z';
  const late = '2026-06-01T00:00:00.000Z';
  const first = mergeSnapshots(snap([a]), snap([ent('a', 'local', late)]), snap([ent('a', 'remote', early)]));
  const second = mergeSnapshots(snap([a]), snap([ent('a', 'local', early)]), snap([ent('a', 'remote', late)]));
  assert.equal(first.status, 'conflicts');
  assert.equal(second.status, 'conflicts');
  const resolved = mergeSnapshots(snap([a]), snap([ent('a', 'local', early)]), snap([ent('a', 'remote', late)]), [{ id: 'a', choice: 'local' }]);
  assert.equal(resolved.status, 'merged');
  if (resolved.status === 'merged') assert.equal(resolved.vault.entries[0].password, 'local');
});

test('merge: every merged entry is traceable to one of the three inputs verbatim', () => {
  const base = snap([a, b, c]);
  const local = snap([a2, c, d]);
  const remote = snap([a, b2, c, e]);
  const outcome = mergeSnapshots(base, local, remote, [{ id: 'a', choice: 'local' }, { id: 'b', choice: 'remote' }]);
  assert.equal(outcome.status, 'merged');
  if (outcome.status === 'merged') {
    const haystack = [base, local, remote].flatMap(item => item.entries);
    for (const entry of outcome.vault.entries) {
      assert.ok(haystack.some(item => JSON.stringify(item) === JSON.stringify(entry)),
        `entry ${entry.id} was synthesised out of nowhere`);
    }
  }
});

test('merge: mergeSnapshots never mutates its inputs', () => {
  const base = snap([a, b]);
  const local = snap([a2, b2]);
  const remote = snap([ent('a', 'other'), ent('b', 'other')]);
  const before = JSON.stringify([base, local, remote]);
  const conflicted = mergeSnapshots(base, local, remote, []);
  assert.equal(conflicted.status, 'conflicts');
  assert.equal(JSON.stringify([base, local, remote]), before);
});

test('merge: 10000-entry vaults merge in a single synchronous pass under a generous budget', () => {
  const baseEntries = Array.from({ length: 10000 }, (_unused, index) => ent(`entry-${index}`));
  const localEntries = baseEntries.map((entry, index) => index === 0 ? ent('entry-0', 'local-edit') : entry);
  const remoteEntries = baseEntries.map((entry, index) => index === 9999 ? ent('entry-9999', 'remote-edit') : entry);
  const started = Date.now();
  const outcome = mergeSnapshots(snap(baseEntries), snap(localEntries), snap(remoteEntries));
  const elapsed = Date.now() - started;
  assert.equal(outcome.status, 'merged');
  if (outcome.status === 'merged') {
    assert.equal(outcome.vault.entries.length, 10000);
    assert.equal(outcome.vault.entries[0].password, 'local-edit');
    assert.equal(outcome.vault.entries[9999].password, 'remote-edit');
  }
  assert.ok(elapsed < 5000, `10000-entry merge took ${elapsed}ms, budget 5000ms`);
});
