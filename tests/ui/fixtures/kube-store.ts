import { emptySnapshots, type SnapshotStore } from '../../../src/features/kube/polling';
import type { SnapshotItems, SnapshotKind } from '../../../src/features/kube/snapshotTypes';
import { NOW } from './kube-data';

/** A store as if each kind listed had just been polled successfully. */
export function storeOf(items: Partial<SnapshotItems>, at = NOW): SnapshotStore {
  const store = emptySnapshots() as Record<SnapshotKind, unknown>;
  for (const [kind, data] of Object.entries(items))
    store[kind as SnapshotKind] = { data, collectedAt: at, state: { kind: 'ready' } };
  return store as SnapshotStore;
}
