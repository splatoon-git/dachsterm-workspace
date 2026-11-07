import { useCallback, useSyncExternalStore } from 'react';
import { call, desktop, errorText } from '../../lib/ipc';

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

/**
 * One poller per connection, shared by the tab, the status bar and the log dialog. A request is
 * sent only after the previous one returns, and polling stops when nothing is watching.
 */
class LogPoller {
  status = off;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  constructor(readonly id: string) {}
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.poll();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearTimeout(this.timer);
        this.timer = undefined;
        pollers.delete(this.id);
      }
    };
  }
  /** Asks now, for a status the user just changed. Waits for a request already on its way. */
  refresh() {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.poll();
  }
  private poll(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = call<LogStatus>('log_status', { id: this.id })
      .then((status) => this.publish(status))
      .catch((e) => this.publish({ ...this.status, error: errorText(e) }))
      .finally(() => {
        this.inFlight = undefined;
        if (this.listeners.size && !this.timer)
          this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.poll();
          }, LOG_POLL_MS);
      });
    return this.inFlight;
  }
  private publish(status: LogStatus) {
    this.status = status;
    this.listeners.forEach((listener) => listener());
  }
}
const pollers = new Map<string, LogPoller>();
const poller = (id: string) => {
  let found = pollers.get(id);
  if (!found) pollers.set(id, (found = new LogPoller(id)));
  return found;
};

export const subscribeLogStatus = (id: string, listener: () => void) =>
  poller(id).subscribe(listener);
export const logStatusOf = (id: string) => pollers.get(id)?.status ?? off;
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
