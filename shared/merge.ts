import type { VaultEntry, VaultSnapshot } from './types.js';

export interface EntryConflict {
  id: string;
  local: VaultEntry | null;
  remote: VaultEntry | null;
}

export type EntryDecision =
  | { id: string; choice: 'local' | 'remote' }
  | { id: string; choice: 'manual'; entry: VaultEntry };

export type MergeOutcome =
  | { status: 'merged'; vault: VaultSnapshot }
  | { status: 'conflicts'; conflicts: EntryConflict[] };

const sameEntry = (x: VaultEntry | null, y: VaultEntry | null): boolean =>
  (x === null && y === null)
  || (x !== null && y !== null && JSON.stringify(x) === JSON.stringify(y));

// Three-way entry-level merge (ADR 0003): base = the unlock baseline snapshot, and divergence is
// decided purely by content equality — createdAt/updatedAt are carried, never compared for order,
// so device clock skew cannot flip an outcome. Shared verbatim by desktop (007) and mobile (011).
export function mergeSnapshots(
  base: VaultSnapshot,
  local: VaultSnapshot,
  remote: VaultSnapshot,
  decisions: EntryDecision[] = [],
): MergeOutcome {
  const index = (snapshot: VaultSnapshot) => new Map(snapshot.entries.map(entry => [entry.id, entry]));
  const b = index(base);
  const l = index(local);
  const r = index(remote);
  const chosen = new Map(decisions.map(decision => [decision.id, decision]));

  const merged: VaultEntry[] = [];
  const conflicts: EntryConflict[] = [];
  const ids = [...new Set([...l.keys(), ...r.keys()])];
  for (const id of ids) {
    const eb = b.get(id) ?? null;
    const el = l.get(id) ?? null;
    const er = r.get(id) ?? null;
    if (sameEntry(el, er)) {
      if (el ?? er) merged.push((el ?? er)!);
      continue;
    }
    if (sameEntry(el, eb)) {
      if (er) merged.push(er);
      continue;
    }
    if (sameEntry(er, eb)) {
      if (el) merged.push(el);
      continue;
    }
    const decision = chosen.get(id);
    if (decision === undefined) {
      conflicts.push({ id, local: el, remote: er });
    } else if (decision.choice === 'local') {
      // An explicit local choice on a local delete means "keep my deletion".
      if (el) merged.push(el);
    } else if (decision.choice === 'remote') {
      if (er) merged.push(er);
    } else if (decision.choice === 'manual' && decision.entry) {
      merged.push({ ...decision.entry, id });
    } else {
      conflicts.push({ id, local: el, remote: er });
    }
  }
  if (conflicts.length) return { status: 'conflicts', conflicts };

  // Settings follow the same three-way shape; both-changed favours local because the device
  // that detected the divergence is the one the user is holding, and autoLockMinutes is a
  // session habit rather than credential data (ticket 006 decision).
  const minutes = local.settings.autoLockMinutes === remote.settings.autoLockMinutes
    ? local.settings.autoLockMinutes
    : local.settings.autoLockMinutes === base.settings.autoLockMinutes
      ? remote.settings.autoLockMinutes
      : local.settings.autoLockMinutes;

  return {
    status: 'merged',
    vault: { entries: merged, settings: { autoLockMinutes: minutes }, revision: Math.max(local.revision, remote.revision) + 1 },
  };
}
