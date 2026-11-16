// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchLines, type MatchRequest, type WorkerReply } from './highlightMatch';
import { HighlightWorker } from './highlightWorker';

/** A worker in this thread. `hang` names a rule that never finishes. */
function fakeWorker(hang?: string) {
  const created: { terminated: boolean }[] = [];
  const create = () => {
    const state = { terminated: false };
    created.push(state);
    const worker = {
      onmessage: null as ((event: MessageEvent<WorkerReply>) => void) | null,
      onerror: null,
      terminate: () => {
        state.terminated = true;
      },
      postMessage: (request: MatchRequest) => {
        const send = (reply: WorkerReply) =>
          setTimeout(() => worker.onmessage?.({ data: reply } as MessageEvent<WorkerReply>));
        for (const rule of request.rules) {
          send({ type: 'rule', id: request.id, rule: rule.id });
          if (rule.id === hang) return;
        }
        send({ type: 'done', id: request.id, matches: matchLines(request.rules, request.lines) });
      },
    };
    return worker;
  };
  return { create, created };
}

const rule = (id: string, pattern = id) => ({ id, pattern, ignoreCase: false });

describe('HighlightWorker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns matches and runs batches in order', async () => {
    const { create } = fakeWorker();
    const worker = new HighlightWorker(create);
    const first = worker.match([rule('a')], ['a']);
    const second = worker.match([rule('b')], ['bb']);
    await vi.runAllTimersAsync();
    expect(await first).toEqual({
      kind: 'done',
      matches: [{ line: 0, rule: 0, start: 0, end: 1 }],
    });
    expect((await second).kind).toBe('done');
  });

  it('ends a batch that runs too long, names its rule and starts a new worker', async () => {
    const { create, created } = fakeWorker('slow');
    const worker = new HighlightWorker(create, 100);
    const stuck = worker.match([rule('fast'), rule('slow')], ['x']);
    await vi.advanceTimersByTimeAsync(99);
    await vi.advanceTimersByTimeAsync(5);
    expect(await stuck).toEqual({ kind: 'timeout', rule: 'slow' });
    expect(created[0].terminated).toBe(true);
    const next = worker.match([rule('fast')], ['fast']);
    await vi.runAllTimersAsync();
    expect((await next).kind).toBe('done');
    expect(created).toHaveLength(2);
  });

  it('gives loading the worker its own time before the batch limit starts', async () => {
    const created: unknown[] = [];
    const worker = new HighlightWorker(() => {
      const w = {
        onmessage: null as ((event: MessageEvent<WorkerReply>) => void) | null,
        onerror: null,
        terminate: () => {},
        // The script takes 500ms to load, then the batch itself is quick.
        postMessage: (request: MatchRequest) =>
          setTimeout(() => {
            w.onmessage?.({ data: { type: 'rule', id: request.id, rule: 'a' } } as MessageEvent);
            w.onmessage?.({ data: { type: 'done', id: request.id, matches: [] } } as MessageEvent);
          }, 500),
      };
      created.push(w);
      return w;
    }, 100);
    const result = worker.match([rule('a')], ['a']);
    await vi.advanceTimersByTimeAsync(600);
    expect(await result).toEqual({ kind: 'done', matches: [] });
  });

  it('reports a worker that cannot start', async () => {
    const worker = new HighlightWorker(() => {
      throw new Error('blocked');
    });
    expect(await worker.match([rule('a')], ['a'])).toEqual({ kind: 'unavailable' });
  });
});
