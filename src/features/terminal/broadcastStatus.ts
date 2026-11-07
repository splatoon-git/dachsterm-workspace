import { useSyncExternalStore } from 'react';
import { call, desktop, errorText } from '../../lib/ipc';
import { Poller } from '../../lib/poller';
import type { BroadcastStatus } from './inputScopeModel';

export const BROADCAST_POLL_MS = 500;
export type WatchedBroadcast = BroadcastStatus & {
  /** The last status request failed. The status itself is the last one received. */
  error?: string;
};
const none: WatchedBroadcast = { targets: [], selected: [] };

/** One poller per window, shared by the status bar, the tab bars and the paste check. */
const poller = new Poller<WatchedBroadcast>({
  read: () => call<BroadcastStatus>('broadcast_status'),
  interval: BROADCAST_POLL_MS,
  initial: none,
  failed: (last, e) => ({ ...last, error: errorText(e) }),
  equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
});
const subscribe = (listener: () => void) => (desktop ? poller.subscribe(listener) : () => {});
const snapshot = () => poller.value;

export function useBroadcastStatus(): WatchedBroadcast {
  return useSyncExternalStore(subscribe, snapshot);
}

/** Sets the group and returns once the shared status shows it. */
export async function setBroadcast(ids: string[]) {
  await call('broadcast_set', { ids });
  await poller.reload();
}

const reach = (selected: string[], connectionId: string) =>
  selected.includes(connectionId) ? selected.length : 1;

/** How many panes a paste into this connection reaches, or 1 when it reaches only its own. */
export function useInputReach(connectionId: string) {
  return reach(useBroadcastStatus().selected, connectionId);
}
/** The same, read once at the moment of a paste the app makes for the user. */
export const inputReach = (connectionId: string) => reach(poller.value.selected, connectionId);
