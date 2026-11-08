import type { IMarker, Terminal } from '@xterm/xterm';
import { terminalPreferences } from './preferences';

/**
 * Command boundaries from OSC 133 (DX.9). `A` starts a prompt, `C` says a typed command started
 * and `D;<code>` that it ended. Our shell hook sends A and D at every prompt; Zsh and Bash 4.4+
 * also send C. Bash 3.2 has no way to, so there the app takes the Enter the user typed at the
 * prompt instead, never one inside a full-screen program. A D without a started command is the
 * prompt repeating the last code after an empty line, and is ignored.
 */
type CommandRecord = {
  prompt: IMarker;
  /** The line the command was typed on, when known. */
  command?: IMarker;
  startedAt?: number;
  exit?: number;
};
export type FailedLine = { line: number; exit: number };
type Host = {
  /** Old output being shown again: marks come back, notifications do not. */
  replaying(): boolean;
  /** A command that ran at least as long as the setting says ended. */
  finished?(exit: number, ms: number): void;
};

const maxRecords = 1000;

/** `A`, `C` or `D;<code>`, with any further fields ignored. Other kinds are not ours to use. */
type Mark = { kind: 'A' } | { kind: 'C' } | { kind: 'D'; exit: number };
export function parseCommandMark(value: string): Mark | null {
  const [kind, code] = value.split(';');
  if (kind === 'A' || kind === 'C') return { kind };
  if (kind !== 'D') return null;
  const exit = Number(code ?? 0);
  return { kind, exit: Number.isInteger(exit) && exit >= 0 ? exit : 0 };
}

const branchPrefix = 'DachsTerm;branch;';
const maxBranchLength = 200;
/** The name in a hook's branch report, empty outside a repository. Null for any other OSC 777. */
export function parseBranchReport(value: string) {
  if (!value.startsWith(branchPrefix)) return null;
  return Array.from(value.slice(branchPrefix.length))
    .filter((c) => c > '\x1f' && (c < '\x7f' || c > '\x9f'))
    .slice(0, maxBranchLength)
    .join('');
}

/** Whether a finished command is long enough to notify about. 0 turns notifications off. */
export const isLongCommand = (ms: number, thresholdSeconds: number) =>
  thresholdSeconds > 0 && ms >= thresholdSeconds * 1000;

export function commandDuration(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

/** The notification body. It never holds the command, which the app does not know. */
export const commandNotice = (exit: number, ms: number) =>
  exit === 0 ? `${commandDuration(ms)} 걸림` : `종료 코드 ${exit} · ${commandDuration(ms)}`;

/** The line a jump moves to: the prompt above the top of the view, or the next one below it. */
export function promptTarget(lines: number[], top: number, direction: -1 | 1) {
  if (direction < 0) return lines.filter((line) => line < top).at(-1);
  return lines.find((line) => line > top);
}

/** Ctrl/Cmd+Shift+↑↓. Ctrl/Cmd+Alt+arrows move between panes and stay with the app. */
export function promptJumpKey(event: KeyboardEvent): -1 | 1 | null {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return null;
  return event.code === 'ArrowUp' ? -1 : event.code === 'ArrowDown' ? 1 : null;
}

export class CommandMarks {
  private records: CommandRecord[] = [];
  /** The latest prompt, which owns the command typed at it. */
  private current: CommandRecord | null = null;
  /** The shell reports command starts itself, so Enter is not needed. */
  private shellStarts = false;
  /** Where the user started typing at the current prompt. */
  private typedFrom: { line: number; x: number } | null = null;
  private listeners = new Set<() => void>();
  private promptListeners = new Set<(replaying: boolean) => void>();
  private branchListeners = new Set<(branch: string) => void>();
  /** What the shell last reported, for the prompt it draws next. Null before any report. */
  branch: string | null = null;
  /** When the latest prompt began. */
  promptAt = 0;
  constructor(
    private readonly terminal: Terminal,
    private readonly host: Host,
  ) {}
  /** Changes to the failed lines and to whether a prompt is waiting. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** Every prompt the shell draws. */
  onPrompt(listener: (replaying: boolean) => void) {
    this.promptListeners.add(listener);
    return () => {
      this.promptListeners.delete(listener);
    };
  }
  /** Every branch report from the shell, never old output shown again. */
  onBranch(listener: (branch: string) => void) {
    this.branchListeners.add(listener);
    return () => {
      this.branchListeners.delete(listener);
    };
  }
  /** Takes a hook's branch report. False for any other OSC 777 text. */
  reportBranch(value: string) {
    const branch = parseBranchReport(value);
    if (branch === null) return false;
    if (this.host.replaying()) return true;
    this.branch = branch;
    this.branchListeners.forEach((listener) => listener(branch));
    this.changed();
    return true;
  }
  /** The shell waits for a command at its prompt. */
  get promptWaiting() {
    const current = this.current;
    return !!current && current.startedAt === undefined && this.normal;
  }
  /** The line the latest prompt began on, or -1 when it has left the buffer. */
  get promptLine() {
    return this.current?.prompt.line ?? -1;
  }
  private changed() {
    this.listeners.forEach((listener) => listener());
  }
  private get normal() {
    return this.terminal.buffer.active.type === 'normal';
  }
  private marker(offset: number) {
    const buffer = this.terminal.buffer.active;
    return this.terminal.registerMarker(Math.max(offset, -(buffer.baseY + buffer.cursorY)));
  }
  handle(value: string) {
    const mark = parseCommandMark(value);
    if (!mark) return;
    const now = Date.now();
    if (mark.kind === 'A') return this.prompt();
    const current = this.current;
    if (!current) return;
    if (mark.kind === 'C') {
      this.shellStarts = true;
      if (current.startedAt === undefined && this.normal) {
        current.startedAt = now;
        // The shell sends C after the Enter, from the line below the command.
        current.command = this.marker(-1);
        this.changed();
      }
      return;
    }
    if (current.startedAt === undefined || current.exit !== undefined) return;
    current.exit = mark.exit;
    if (mark.exit !== 0) this.changed();
    const ms = now - current.startedAt;
    if (!this.host.replaying() && isLongCommand(ms, terminalPreferences().longCommandNotify))
      this.host.finished?.(mark.exit, ms);
  }
  private prompt() {
    this.typedFrom = null;
    this.current = null;
    this.promptAt = Date.now();
    if (!this.normal) return this.changed();
    const record: CommandRecord = { prompt: this.marker(0) };
    record.prompt.onDispose(() => {
      const index = this.records.indexOf(record);
      if (index < 0) return;
      this.records.splice(index, 1);
      if (this.current === record) this.current = null;
      record.command?.dispose();
      if (record.exit) this.changed();
    });
    this.records.push(record);
    this.current = record;
    if (this.records.length > maxRecords) this.records[0].prompt.dispose();
    const replaying = this.host.replaying();
    this.promptListeners.forEach((listener) => listener(replaying));
    this.changed();
  }
  /** What the user typed at the prompt, for shells that do not report command starts. */
  input(data: string) {
    const current = this.current;
    if (this.shellStarts || !current || current.startedAt !== undefined || !this.normal) return;
    if (this.host.replaying()) return;
    const buffer = this.terminal.buffer.active;
    this.typedFrom ??= { line: buffer.baseY + buffer.cursorY, x: buffer.cursorX };
    const enter = data.indexOf('\r');
    if (enter < 0) return;
    // An empty line only draws the prompt again. Echo may lag, so the sent text counts too.
    let typed = data.slice(0, enter);
    const end = buffer.baseY + buffer.cursorY;
    for (let line = this.typedFrom.line; line <= end; line++)
      typed +=
        buffer
          .getLine(line)
          ?.translateToString(true, line === this.typedFrom.line ? this.typedFrom.x : 0) ?? '';
    if (!typed.trim()) return;
    current.startedAt = Date.now();
    current.command = this.marker(0);
    this.changed();
  }
  /** Scrolls to the previous or next prompt. False when there is none to move to. */
  jump(direction: -1 | 1) {
    const buffer = this.terminal.buffer.active;
    if (buffer.type !== 'normal' || !this.records.length) return false;
    const lines = this.records.map((r) => r.prompt.line).filter((line) => line >= 0);
    const target = promptTarget(lines, buffer.viewportY, direction);
    if (target !== undefined) this.terminal.scrollToLine(target);
    else if (direction > 0) this.terminal.scrollToBottom();
    return true;
  }
  failedLines(): FailedLine[] {
    return this.records.flatMap((r) => {
      const line = (r.command ?? r.prompt).line;
      return r.exit && line >= 0 ? [{ line, exit: r.exit }] : [];
    });
  }
}

const registry = new WeakMap<Terminal, CommandMarks>();

/** The marks of a terminal, for its pane's keys and overlay and for Git status. */
export const commandMarksOf = (terminal: Terminal) => registry.get(terminal);

/** Registers the handlers. The terminal's own dispose removes them. */
export function attachCommandMarks(terminal: Terminal, host: Host) {
  const marks = new CommandMarks(terminal, host);
  registry.set(terminal, marks);
  terminal.parser.registerOscHandler(133, (value) => {
    marks.handle(value);
    // Other handlers of this sequence still run.
    return false;
  });
  terminal.onData((data) => marks.input(data));
  return marks;
}

/** Handles the prompt jump keys in a terminal's key handler. True when the key was used. */
export function handlePromptJumpKey(terminal: Terminal, event: KeyboardEvent) {
  const direction = promptJumpKey(event);
  if (direction === null || !commandMarksOf(terminal)?.jump(direction)) return false;
  event.preventDefault();
  return true;
}
