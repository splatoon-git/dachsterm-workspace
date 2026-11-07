import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throttleTrailing } from './fitThrottle';

describe('throttleTrailing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at once and then once per interval while called', () => {
    const run = vi.fn();
    const throttled = throttleTrailing(run, 60);
    throttled.call();
    expect(run).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(10);
      throttled.call();
    }
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('runs once more after the last call so the final size is applied', () => {
    const run = vi.fn();
    const throttled = throttleTrailing(run, 60);
    throttled.call();
    throttled.call();
    throttled.call();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60);
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(600);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs at once again after going quiet', () => {
    const run = vi.fn();
    const throttled = throttleTrailing(run, 60);
    throttled.call();
    vi.advanceTimersByTime(60);
    throttled.call();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('drops pending work when cancelled', () => {
    const run = vi.fn();
    const throttled = throttleTrailing(run, 60);
    throttled.call();
    throttled.call();
    throttled.cancel();
    vi.advanceTimersByTime(600);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
