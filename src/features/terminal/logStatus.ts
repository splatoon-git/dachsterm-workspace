import { useCallback, useSyncExternalStore } from 'react';
import { call, desktop, errorText } from '../../lib/ipc';
import { Poller } from '../../lib/poller';

export type LogStatus = {
  state: string;
  path: string;
  message: string;
  bytes: number;
  /** The last status request failed. The status itself is the last one received. */
  error?: string;
};
export const LOG_POLL_MS = 750;
const off: LogStatus = { state: 'off', path: '', message: '', bytes: 0 };
export const isRecording = (status: LogStatus) =>
  ['recording', 'paused', 'stopping'].includes(status.state);

/** One poller per connection, shared by the tab, the status bar and the log dialog. */
const pollers = new Map<string, Poller<LogStatus>>();
const poller = (id: string) => {
  let found = pollers.get(id);
  if (!found)
    pollers.set(
      id,
      (found = new Poller({
        read: () => call<LogStatus>('log_status', { id }),
        interval: LOG_POLL_MS,
        initial: off,
        failed: (last, e) => ({ ...last, error: errorText(e) }),
        idle: () => pollers.delete(id),
      })),
    );
  return found;
};

export const subscribeLogStatus = (id: string, listener: () => void) =>
  poller(id).subscribe(listener);
export const logStatusOf = (id: string) => pollers.get(id)?.value ?? off;
export const refreshLogStatus = (id: string) => pollers.get(id)?.refresh() ?? Promise.resolve();

/** The session log status of a connection, or "off" for one that cannot record. */
export function useLogStatus(id: string | null): LogStatus {
  const watch = !!id && desktop;
  const subscribe = useCallback(
    (listener: () => void) => (watch ? subscribeLogStatus(id, listener) : () => {}),
    [id, watch],
  );
  return useSyncExternalStore(subscribe, () => (watch ? logStatusOf(id) : off));
}
