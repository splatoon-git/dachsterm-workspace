import type { Match, MatchRule, WorkerReply } from './highlightMatch';

/** A batch that runs longer than this ends the worker and stops the rule that was running. */
export const batchLimitMs = 100;
/** Loading the worker's script is not the rules' time. A worker that never starts is unavailable. */
const startLimitMs = 5000;

export type MatchResult =
  | { kind: 'done'; matches: Match[] }
  /** The batch ran too long. `rule` was running then, when the worker said which. */
  | { kind: 'timeout'; rule: string | null }
  | { kind: 'unavailable' };

type WorkerLike = Pick<Worker, 'postMessage' | 'terminate'> & {
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};
type Job = {
  rules: MatchRule[];
  lines: string[];
  resolve: (result: MatchResult) => void;
};

const createWorker = (): WorkerLike =>
  new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });

/**
 * One worker for every tab in the window, running one batch at a time. Batches queue in order, so a
 * tab's lines are matched in the order they were written.
 */
export class HighlightWorker {
  private worker: WorkerLike | null = null;
  private queue: Job[] = [];
  private running: {
    job: Job;
    id: number;
    rule: string | null;
    timer: number;
  } | null = null;
  private next = 1;
  constructor(
    private readonly create: () => WorkerLike = createWorker,
    private readonly limit = batchLimitMs,
  ) {}

  match(rules: MatchRule[], lines: string[]): Promise<MatchResult> {
    if (!rules.length || !lines.length) return Promise.resolve({ kind: 'done', matches: [] });
    return new Promise((resolve) => {
      this.queue.push({ rules, lines, resolve });
      this.pump();
    });
  }

  /** Batches still waiting, so a tab can skip work while the worker falls behind. */
  get waiting() {
    return this.queue.length + (this.running ? 1 : 0);
  }

  private start() {
    if (this.worker) return this.worker;
    try {
      const worker = this.create();
      worker.onmessage = (event) => this.received(event.data);
      worker.onerror = () => this.finish({ kind: 'unavailable' }, true);
      this.worker = worker;
      return worker;
    } catch {
      return null;
    }
  }

  private pump() {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    const worker = this.start();
    if (!worker) {
      job.resolve({ kind: 'unavailable' });
      this.pump();
      return;
    }
    const id = this.next++;
    const timer = window.setTimeout(() => this.finish({ kind: 'unavailable' }, true), startLimitMs);
    this.running = { job, id, rule: null, timer };
    worker.postMessage({ id, rules: job.rules, lines: job.lines });
  }

  private received(reply: WorkerReply) {
    const running = this.running;
    if (!running || reply.id !== running.id) return;
    if (reply.type === 'done') {
      this.finish({ kind: 'done', matches: reply.matches }, false);
      return;
    }
    // The clock starts with the first rule, after the worker's script has loaded.
    if (running.rule === null) {
      window.clearTimeout(running.timer);
      running.timer = window.setTimeout(
        () => this.finish({ kind: 'timeout', rule: this.running?.rule ?? null }, true),
        this.limit,
      );
    }
    running.rule = reply.rule;
  }

  /** Ends the running batch. A stuck or broken worker is replaced on the next batch. */
  private finish(result: MatchResult, discard: boolean) {
    const running = this.running;
    if (!running) return;
    window.clearTimeout(running.timer);
    this.running = null;
    if (discard) {
      this.worker?.terminate();
      this.worker = null;
    }
    running.job.resolve(result);
    this.pump();
  }
}

let shared: HighlightWorker | null = null;
export const highlightWorker = () => (shared ??= new HighlightWorker());
