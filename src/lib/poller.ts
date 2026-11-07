/**
 * A value read from the backend on an interval and shared by everything that watches it. A
 * request is sent only after the previous one returns, and polling stops when nothing watches.
 */
export class Poller<T> {
  value: T;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private generation = 0;
  constructor(
    private readonly options: {
      read: () => Promise<T>;
      interval: number;
      initial: T;
      /** The value to show when a request fails; the last value is passed in. */
      failed: (last: T, error: unknown) => T;
      /** Values that read the same are not published, so watchers do not render again. */
      equal?: (a: T, b: T) => boolean;
      /** Called when the last watcher leaves. */
      idle?: () => void;
    },
  ) {
    this.value = options.initial;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.poll();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.options.idle?.();
      }
    };
  }
  /** Asks now, for a status the user just changed. Waits for a request already on its way. */
  refresh() {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.poll();
  }
  /** Drops an answer already on its way, which may predate a change made just now, and asks again. */
  async reload() {
    this.generation++;
    await this.inFlight;
    return this.refresh();
  }
  private poll(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const publish = (value: T) => {
      if (generation === this.generation) this.publish(value);
    };
    this.inFlight = this.options
      .read()
      .then(publish)
      .catch((e) => publish(this.options.failed(this.value, e)))
      .finally(() => {
        this.inFlight = undefined;
        if (this.listeners.size && !this.timer)
          this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.poll();
          }, this.options.interval);
      });
    return this.inFlight;
  }
  private publish(value: T) {
    if (this.options.equal?.(this.value, value)) return;
    this.value = value;
    this.listeners.forEach((listener) => listener());
  }
}
