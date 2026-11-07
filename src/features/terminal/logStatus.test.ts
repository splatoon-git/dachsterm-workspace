import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pending: ((value: unknown) => void)[] = [];
const call = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
vi.mock('../../lib/ipc', () => ({
  call: (...args: unknown[]) => call(...(args as [])),
  desktop: true,
  errorText: (e: unknown) => String(e),
}));
const { LOG_POLL_MS, logStatusOf, refreshLogStatus, subscribeLogStatus } =
  await import('./logStatus');
const status = (state: string) => ({ state, path: '', message: '', bytes: 0 });

beforeEach(() => {
  vi.useFakeTimers();
  call.mockClear();
  pending.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('session log status', () => {
  it('shares one request among watchers and waits for it before the next', async () => {
    const stopA = subscribeLogStatus('a', () => {});
    const stopB = subscribeLogStatus('a', () => {});
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS * 3);
    expect(call).toHaveBeenCalledTimes(1);
    pending.shift()!(status('recording'));
    await vi.advanceTimersByTimeAsync(0);
    expect(logStatusOf('a').state).toBe('recording');
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    expect(call).toHaveBeenCalledTimes(2);
    stopA();
    stopB();
  });

  it('stops polling when the last watcher leaves', async () => {
    const stop = subscribeLogStatus('b', () => {});
    pending.shift()!(status('off'));
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS * 4);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('refreshes at once, joining a request already on its way', async () => {
    const stop = subscribeLogStatus('c', () => {});
    const refreshed = refreshLogStatus('c');
    expect(call).toHaveBeenCalledTimes(1);
    pending.shift()!(status('paused'));
    await refreshed;
    expect(logStatusOf('c').state).toBe('paused');
    void refreshLogStatus('c');
    expect(call).toHaveBeenCalledTimes(2);
    stop();
  });

  it('keeps the last status and reports a failed request', async () => {
    const stop = subscribeLogStatus('d', () => {});
    pending.shift()!(status('recording'));
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    call.mockImplementationOnce(() => Promise.reject('끊김'));
    pending.shift()!(status('recording'));
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    expect(logStatusOf('d')).toMatchObject({ state: 'recording', error: '끊김' });
    stop();
  });
});
