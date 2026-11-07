// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  CommandMarks,
  commandDuration,
  commandNotice,
  isLongCommand,
  parseCommandMark,
  promptJumpKey,
  promptTarget,
} from './commandMarks';
import { saveTerminalPreferences } from './preferences';

/** Just enough of xterm: a cursor, line text and markers that can be trimmed. */
function fakeTerminal() {
  const lines = new Map<number, string>();
  const buffer = {
    type: 'normal',
    baseY: 0,
    cursorY: 0,
    cursorX: 0,
    viewportY: 0,
    getLine: (y: number) => ({
      translateToString: (_trim: boolean, start = 0) => (lines.get(y) ?? '').slice(start),
    }),
  };
  const markers: { line: number; dispose(): void }[] = [];
  const terminal = {
    buffer: { active: buffer },
    scrolled: [] as (number | 'bottom')[],
    registerMarker(offset = 0) {
      const disposers: (() => void)[] = [];
      const marker = {
        line: buffer.baseY + buffer.cursorY + offset,
        onDispose: (fn: () => void) => disposers.push(fn),
        dispose() {
          marker.line = -1;
          disposers.forEach((fn) => fn());
        },
      };
      markers.push(marker);
      return marker;
    },
    scrollToLine(line: number) {
      terminal.scrolled.push(line);
    },
    scrollToBottom() {
      terminal.scrolled.push('bottom');
    },
  };
  return { terminal, buffer, lines, markers };
}

function setup(replaying = false) {
  const fake = fakeTerminal();
  const finished = vi.fn();
  const marks = new CommandMarks(fake.terminal as unknown as Terminal, {
    replaying: () => replaying,
    finished,
  });
  const at = (y: number, x = 0) => {
    fake.buffer.cursorY = y;
    fake.buffer.cursorX = x;
  };
  return { ...fake, marks, finished, at };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  saveTerminalPreferences({ longCommandNotify: 30 });
});
afterEach(() => vi.useRealTimers());

describe('command marks', () => {
  it('reads A, C and D with its code, and nothing else', () => {
    expect(parseCommandMark('A')).toEqual({ kind: 'A' });
    expect(parseCommandMark('A;cl=m')).toEqual({ kind: 'A' });
    expect(parseCommandMark('C')).toEqual({ kind: 'C' });
    expect(parseCommandMark('D;2')).toEqual({ kind: 'D', exit: 2 });
    expect(parseCommandMark('D')).toEqual({ kind: 'D', exit: 0 });
    expect(parseCommandMark('D;x')).toEqual({ kind: 'D', exit: 0 });
    expect(parseCommandMark('B')).toBeNull();
    expect(parseCommandMark('P;k=v')).toBeNull();
  });

  it('marks the failed command line that the shell reported', () => {
    const { marks, at, finished } = setup();
    at(3);
    marks.handle('A');
    at(4);
    marks.handle('C');
    vi.setSystemTime(40_000);
    at(9);
    marks.handle('D;2');
    // C arrives on the line under the command.
    expect(marks.failedLines()).toEqual([{ line: 3, exit: 2 }]);
    expect(finished).toHaveBeenCalledWith(2, 40_000);
  });

  it('ignores the code an empty line repeats', () => {
    const { marks, at } = setup();
    marks.handle('A');
    marks.handle('C');
    marks.handle('D;1');
    at(2);
    marks.handle('A');
    marks.handle('D;1');
    expect(marks.failedLines()).toHaveLength(1);
  });

  it('notifies only long commands, never during a replay, and not when turned off', () => {
    const short = setup();
    short.marks.handle('A');
    short.marks.handle('C');
    vi.setSystemTime(29_000);
    short.marks.handle('D;0');
    expect(short.finished).not.toHaveBeenCalled();
    vi.setSystemTime(0);
    const replay = setup(true);
    replay.marks.handle('A');
    replay.marks.handle('C');
    vi.setSystemTime(60_000);
    replay.marks.handle('D;1');
    expect(replay.finished).not.toHaveBeenCalled();
    expect(replay.marks.failedLines()).toHaveLength(1);
    saveTerminalPreferences({ longCommandNotify: 0 });
    expect(isLongCommand(3_600_000, 0)).toBe(false);
    expect(isLongCommand(30_000, 30)).toBe(true);
  });

  it('takes the Enter typed at the prompt when the shell does not report starts', () => {
    const { marks, at, lines, finished } = setup();
    at(0, 10);
    lines.set(0, 'bash-3.2$ ');
    marks.handle('A');
    marks.input('\r');
    marks.handle('D;1');
    expect(marks.failedLines()).toEqual([]);
    at(1, 10);
    marks.handle('A');
    marks.input('m');
    lines.set(1, 'bash-3.2$ make');
    at(1, 14);
    marks.input('\r');
    vi.setSystemTime(31_000);
    at(5);
    marks.handle('D;2');
    expect(marks.failedLines()).toEqual([{ line: 1, exit: 2 }]);
    expect(finished).toHaveBeenCalledWith(2, 31_000);
  });

  it('counts a pasted command before its echo arrives, and no Enter inside a program', () => {
    const { marks, at, buffer } = setup();
    at(0, 2);
    marks.handle('A');
    marks.input('false\r');
    marks.handle('D;1');
    expect(marks.failedLines()).toHaveLength(1);
    at(1, 2);
    marks.handle('A');
    buffer.type = 'alternate';
    marks.input('x\r');
    buffer.type = 'normal';
    marks.handle('D;1');
    expect(marks.failedLines()).toHaveLength(1);
  });

  it('stops using Enter once the shell reports starts', () => {
    const { marks, at } = setup();
    marks.handle('A');
    marks.handle('C');
    marks.handle('D;0');
    at(2, 2);
    marks.handle('A');
    marks.input('make\r');
    marks.handle('D;2');
    expect(marks.failedLines()).toEqual([]);
  });

  it('forgets marks trimmed out of the scrollback', () => {
    const { marks, at, markers } = setup();
    marks.handle('A');
    marks.handle('C');
    at(1);
    marks.handle('D;1');
    expect(marks.failedLines()).toHaveLength(1);
    markers[0].dispose();
    expect(marks.failedLines()).toEqual([]);
    expect(marks.jump(-1)).toBe(false);
  });

  it('jumps between prompts from the top of the view', () => {
    const { marks, at, buffer, terminal } = setup();
    for (const y of [0, 10, 20]) {
      at(y);
      marks.handle('A');
    }
    buffer.viewportY = 15;
    expect(marks.jump(-1)).toBe(true);
    marks.jump(1);
    buffer.viewportY = 20;
    marks.jump(1);
    expect(terminal.scrolled).toEqual([10, 20, 'bottom']);
    expect(promptTarget([0, 10], 0, -1)).toBeUndefined();
  });

  it('uses Ctrl or Cmd with Shift and an up or down arrow', () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
    expect(promptJumpKey(key({ code: 'ArrowUp', ctrlKey: true, shiftKey: true }))).toBe(-1);
    expect(promptJumpKey(key({ code: 'ArrowDown', metaKey: true, shiftKey: true }))).toBe(1);
    expect(promptJumpKey(key({ code: 'ArrowUp', ctrlKey: true, altKey: true }))).toBeNull();
    expect(
      promptJumpKey(key({ code: 'ArrowUp', ctrlKey: true, shiftKey: true, altKey: true })),
    ).toBeNull();
    expect(promptJumpKey(key({ code: 'ArrowUp', shiftKey: true }))).toBeNull();
    expect(promptJumpKey(key({ code: 'ArrowLeft', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('describes a finished command without its text', () => {
    expect(commandDuration(45_000)).toBe('45초');
    expect(commandDuration(185_000)).toBe('3분 5초');
    expect(commandDuration(3_720_000)).toBe('1시간 2분');
    expect(commandNotice(0, 31_000)).toBe('31초 걸림');
    expect(commandNotice(2, 31_000)).toBe('종료 코드 2 · 31초');
  });
});
