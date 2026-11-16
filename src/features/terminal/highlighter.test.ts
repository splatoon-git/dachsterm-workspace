// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal, type IDecorationOptions } from '@xterm/xterm';
import { themes } from '../../themes/registry';
import { matchLines, type MatchRequest, type WorkerReply } from './highlightMatch';
import { blankRule, type HighlightRule } from './highlightRules';
import { applyHighlightLibrary } from './highlightStore';
import { HighlightWorker } from './highlightWorker';
import { Highlighter, pauseBytesPerSecond } from './highlighter';

const calls: { command: string; args?: Record<string, unknown> }[] = [];
let broadcast: string[] = [];
vi.mock('../../lib/ipc', () => ({
  call: (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === 'broadcast_status')
      return Promise.resolve({ targets: [], selected: broadcast });
    return Promise.resolve(null);
  },
  errorText: String,
  desktop: false,
}));

/** Matching in this thread, answered right away. */
const syncWorker = () =>
  new HighlightWorker(() => {
    const worker = {
      onmessage: null as ((event: MessageEvent<WorkerReply>) => void) | null,
      onerror: null,
      terminate: () => {},
      postMessage: (request: MatchRequest) =>
        queueMicrotask(() => {
          for (const rule of request.rules)
            worker.onmessage?.({ data: { type: 'rule', id: request.id, rule: rule.id } } as never);
          const matches = matchLines(request.rules, request.lines);
          worker.onmessage?.({ data: { type: 'done', id: request.id, matches } } as never);
        }),
    };
    return worker;
  });

const rule = (patch: Partial<HighlightRule>): HighlightRule => ({
  ...blankRule(),
  name: '오류',
  pattern: 'ERROR',
  ...patch,
});

function setup(rules: HighlightRule[], tags: string[] = []) {
  applyHighlightLibrary({ revision: 1, items: rules });
  const terminal = new Terminal({ cols: 20, rows: 6, allowProposedApi: true });
  const painted: IDecorationOptions[] = [];
  const register = terminal.registerDecoration.bind(terminal);
  terminal.registerDecoration = (options) => {
    painted.push(options);
    return register(options);
  };
  const notices: string[] = [];
  const sent: string[] = [];
  const paused: boolean[] = [];
  const highlighter = new Highlighter(
    {
      terminal,
      target: () => ({ profileId: 'p1', tags }),
      sessionName: () => '서버',
      connectionId: () => 'c1',
      replaying: () => false,
      notice: (m) => notices.push(m),
      send: (d) => sent.push(d),
      paused: (v) => paused.push(v),
    },
    themes[0],
    syncWorker(),
  );
  // xterm schedules its parsing with timers too, so they advance while the write waits.
  const write = async (text: string) => {
    const written = new Promise<void>((done) => terminal.write(text, done));
    await vi.advanceTimersByTimeAsync(20);
    await written;
    await vi.advanceTimersByTimeAsync(50);
  };
  return { terminal, highlighter, painted, notices, sent, paused, write };
}

describe('Highlighter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    calls.length = 0;
    broadcast = [];
  });
  afterEach(() => vi.useRealTimers());

  it('colors matches with the theme palette, across wrapped rows and wide characters', async () => {
    const { painted, write } = setup([rule({})]);
    await write('ok\r\n한글 ERROR here\r\n0123456789abcdefgERROR\r\n$ ');
    expect(painted.map(({ x, width, foregroundColor }) => [x, width, foregroundColor])).toEqual([
      // Two wide characters and a space: four cells, then one.
      [5, 5, themes[0].terminal.red],
      // 'ERROR' starts at column 17 of a 20-column row and wraps after 'ERR'.
      [17, 3, themes[0].terminal.red],
      [0, 2, themes[0].terminal.red],
    ]);
  });

  it('repaints with the new theme', async () => {
    const { highlighter, painted, write } = setup([rule({ color: 'info' })]);
    await write('ERROR\r\n');
    const other = themes.find((t) => t.terminal.blue !== themes[0].terminal.blue)!;
    highlighter.setTheme(other);
    expect(painted.at(-1)?.foregroundColor).toBe(other.terminal.blue);
  });

  it('answers a prompt once while its line is still being written, then waits 10 seconds', async () => {
    const { sent, notices, write } = setup([
      rule({
        pattern: 'Continue\\? \\[y/n\\]',
        color: null,
        send: { text: 'y\n', confirmedAt: 1 },
      }),
    ]);
    await write('Continue? [y/n] ');
    await write(' ');
    expect(sent).toEqual(['y\r']);
    expect(notices).toContain('트리거 입력: 오류');
    await write('\r\nContinue? [y/n] ');
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await write('\r\nContinue? [y/n] ');
    expect(sent).toHaveLength(2);
  });

  it('does not answer while typing reaches a multi-input group', async () => {
    broadcast = ['c1', 'c2'];
    const { sent, notices, write } = setup([
      rule({ pattern: 'Continue', color: null, send: { text: 'y', confirmedAt: 1 } }),
    ]);
    await write('Continue\r\n');
    expect(sent).toEqual([]);
    expect(notices.join()).toMatch(/동시 입력/);
  });

  it('notifies on a match and follows the rule scope', async () => {
    const { notices, write } = setup(
      [rule({ notify: true, color: null, scope: { kind: 'tags', tags: ['db'] } })],
      ['db'],
    );
    await write('disk ERROR\r\n');
    expect(notices).toContain("하이라이트 '오류': disk ERROR");
    expect(calls.some((c) => c.command === 'notification_show')).toBe(true);
    const other = setup([rule({ notify: true, scope: { kind: 'tags', tags: ['web'] } })], ['db']);
    await other.write('ERROR\r\n');
    expect(other.notices).toEqual([]);
  });

  it('pauses while output is too fast and resumes after it slows', async () => {
    const { highlighter, painted, paused, write } = setup([rule({})]);
    highlighter.output(pauseBytesPerSecond + 1);
    await write('ERROR\r\n');
    expect(paused).toEqual([true]);
    expect(painted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(paused).toEqual([true, false]);
    await write('ERROR\r\n');
    expect(painted).toHaveLength(1);
  });

  it('does not report a pause in a tab without rules', async () => {
    const { highlighter, paused } = setup([]);
    highlighter.output(pauseBytesPerSecond + 1);
    expect(paused).toEqual([]);
  });

  it('turned off in a tab, clears its colors; turned on again, skips earlier lines', async () => {
    const { highlighter, notices, painted, write } = setup([rule({ notify: true })]);
    highlighter.setEnabled(false);
    await write('ERROR one\r\n');
    expect(painted).toEqual([]);
    highlighter.setEnabled(true);
    await write('fine\r\n');
    expect(notices).toEqual([]);
    await write('ERROR two\r\n');
    expect(notices).toEqual(["하이라이트 '오류': ERROR two"]);
  });
});
