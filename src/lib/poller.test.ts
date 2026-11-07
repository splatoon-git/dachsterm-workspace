import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Poller } from './poller';

const pending: ((value: number) => void)[] = [];
const read = vi.fn(() => new Promise<number>((resolve) => pending.push(resolve)));
const make = (equal?: (a: number, b: number) => boolean) =>
  new Poller<number>({ read, interval: 100, initial: 0, failed: (last) => last, equal });

beforeEach(() => {
  vi.useFakeTimers();
  read.mockClear();
  pending.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('poller', () => {
  it('drops an answer that left before a reload and keeps the one after it', async () => {
    const poller = make();
    const stop = poller.subscribe(() => {});
    const reloaded = poller.reload();
    pending.shift()!(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.value).toBe(0);
    pending.shift()!(2);
    await reloaded;
    expect(poller.value).toBe(2);
    stop();
  });

  it('does not tell watchers about a value that reads the same', async () => {
    const poller = make((a, b) => a === b);
    const seen = vi.fn();
    const stop = poller.subscribe(seen);
    pending.shift()!(0);
    await vi.advanceTimersByTimeAsync(100);
    pending.shift()!(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(poller.value).toBe(3);
    stop();
  });
});
