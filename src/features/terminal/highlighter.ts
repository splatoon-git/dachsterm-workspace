import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { call, errorText } from '../../lib/ipc';
import { appNotificationLimiter, notificationBody } from '../../lib/notifications';
import type { ThemeDefinition } from '../../themes/contract';
import { logicalLines, logicalStart, matchSpans, type LogicalLine } from './highlightBuffer';
import type { Match } from './highlightMatch';
import {
  highlightHex,
  ruleApplies,
  triggerInput,
  triggerIntervalMs,
  type HighlightColor,
  type HighlightRule,
  type HighlightTarget,
} from './highlightRules';
import {
  activeHighlightRules,
  saveHighlightRules,
  highlightLibrary,
  stopHighlightRule,
  subscribeHighlightRules,
} from './highlightStore';
import { highlightWorker, type HighlightWorker } from './highlightWorker';
import type { BroadcastStatus } from './inputScopeModel';

/** Decorations one batch may add, and those a tab keeps. The oldest go first. */
export const batchDecorations = 200;
export const liveDecorations = 2000;
/** Output faster than this pauses highlighting; matching would fall behind the screen. */
export const pauseBytesPerSecond = 4 * 1024 * 1024;
/** Rows one batch reads at most. Older rows of a burst are skipped. */
const maxRows = 1000;
const scanDelayMs = 16;

export type HighlighterHost = {
  terminal: Terminal;
  target: () => HighlightTarget;
  sessionName: () => string;
  connectionId: () => string;
  replaying: () => boolean;
  notice: (message: string) => void;
  /** Types into this tab only, as if the user typed it. */
  send: (data: string) => void;
  /** Highlighting paused or resumed because of the output rate. */
  paused: (value: boolean) => void;
};

type Painted = {
  marker: IMarker;
  decoration?: IDecoration;
  color: HighlightColor;
  x: number;
  width: number;
};

/**
 * Colors rule matches in one terminal and runs their notices and typed answers (CG.7). It reads
 * the rows output changed from xterm's buffer, so escape sequences are already gone and nothing is
 * added to the output itself: session logs and copies keep the server's bytes.
 */
export class Highlighter {
  private theme: ThemeDefinition;
  private on = true;
  private pausedNow = false;
  /** The start of the logical line the cursor was on after the last batch. */
  private resume: IMarker | null = null;
  /** Rules that already fired on that line, so a line still being written fires once. */
  private fired = new Set<string>();
  private painted: Painted[] = [];
  private timer = 0;
  private busy = false;
  private again = false;
  private rate = { start: 0, bytes: 0 };
  private rateTimer = 0;
  private lastTrigger = -Infinity;
  private unavailable = false;
  private disposed = false;
  private readonly subscriptions: IDisposable[] = [];
  private readonly unsubscribe: () => void;

  constructor(
    private readonly host: HighlighterHost,
    theme: ThemeDefinition,
    private readonly worker: HighlightWorker = highlightWorker(),
  ) {
    this.theme = theme;
    this.subscriptions.push(host.terminal.onWriteParsed(() => this.schedule()));
    // New or changed rules apply to output from now on; what is painted stays until it scrolls away.
    this.unsubscribe = subscribeHighlightRules(() => {
      if (!this.rules().length) this.clear();
    });
  }

  get enabled() {
    return this.on;
  }

  /** The tab menu's switch. Off removes this tab's colors and stops its notices and answers. */
  setEnabled(value: boolean) {
    this.on = value;
    if (!value) this.clear();
    // Turning on again starts at the cursor: earlier lines must not fire their rules late.
    else if (this.host.terminal.buffer.active.type === 'normal')
      this.markResume(logicalStart(this.host.terminal.buffer.active, this.cursorRow()));
  }

  /** Called for every output frame, before it is written. */
  output(bytes: number) {
    const now = performance.now();
    if (now - this.rate.start >= 1000) {
      const rate = (this.rate.bytes * 1000) / Math.max(1, now - this.rate.start);
      this.rate = { start: now, bytes: 0 };
      if (this.pausedNow && rate <= pauseBytesPerSecond) this.setPaused(false);
    }
    this.rate.bytes += bytes;
    // Only a tab with rules to run says it paused them.
    if (!this.pausedNow && this.rate.bytes > pauseBytesPerSecond && this.on && this.rules().length)
      this.setPaused(true);
  }

  private setPaused(value: boolean) {
    this.pausedNow = value;
    this.host.paused(value);
    window.clearTimeout(this.rateTimer);
    // Output that stops altogether sends no frame to resume on.
    if (value) this.rateTimer = window.setTimeout(() => this.output(0), 1100);
  }

  setTheme(theme: ThemeDefinition) {
    this.theme = theme;
    for (const item of this.painted) {
      item.decoration?.dispose();
      item.decoration = this.decorate(item.marker, item.x, item.width, item.color);
    }
  }

  dispose() {
    this.disposed = true;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.rateTimer);
    this.subscriptions.forEach((s) => s.dispose());
    this.unsubscribe();
    this.clear();
    this.resume?.dispose();
  }

  private rules() {
    const target = this.host.target();
    return activeHighlightRules().filter((rule) => ruleApplies(rule, target));
  }

  private clear() {
    for (const item of this.painted) item.marker.dispose();
    this.painted = [];
  }

  private schedule() {
    if (this.busy) {
      this.again = true;
      return;
    }
    if (!this.timer) this.timer = window.setTimeout(() => void this.scan(), scanDelayMs);
  }

  private cursorRow() {
    const buffer = this.host.terminal.buffer.active;
    return buffer.baseY + buffer.cursorY;
  }

  /** Marks where the next batch starts: the logical line the cursor is on now. */
  private markResume(row: number) {
    this.resume?.dispose();
    this.resume = this.host.terminal.registerMarker(row - this.cursorRow());
  }

  private async scan() {
    this.timer = 0;
    const terminal = this.host.terminal;
    // Decorations and markers live in the normal buffer; full-screen programs draw elsewhere.
    if (terminal.buffer.active.type !== 'normal') return;
    const buffer = terminal.buffer.active;
    const cursor = this.cursorRow();
    const end = logicalStart(buffer, cursor);
    const rules = this.on && !this.pausedNow && !this.unavailable ? this.rules() : [];
    // No mark yet, or the terminal was reset: the buffer holds only output not yet read.
    const resumed = this.resume && !this.resume.isDisposed ? this.resume.line : null;
    const first = logicalStart(buffer, Math.max(resumed ?? 0, cursor - maxRows));
    const carried = resumed !== null && first === resumed;
    this.markResume(end);
    if (!rules.length) {
      this.fired.clear();
      return;
    }
    const lines = logicalLines(buffer, first, cursor);
    const anchor = terminal.registerMarker(first - cursor);
    this.busy = true;
    try {
      const result = await this.worker.match(
        rules.map(({ id, pattern, ignoreCase }) => ({ id, pattern, ignoreCase })),
        lines.map((line) => line.text),
      );
      // The tab closed while the worker matched.
      if (this.disposed) return;
      if (result.kind === 'timeout') this.stopped(result.rule);
      else if (result.kind === 'unavailable') {
        this.unavailable = true;
        this.host.notice('이 화면에서 하이라이트 검사를 시작하지 못했습니다.');
      } else this.apply(rules, lines, result.matches, anchor, carried);
    } finally {
      anchor.dispose();
      this.busy = false;
      if (this.again && !this.disposed) {
        this.again = false;
        this.schedule();
      }
    }
  }

  /** A rule whose matching ran too long is turned off, here and in the saved rules. */
  private stopped(id: string | null) {
    const name = id ? stopHighlightRule(id) : '';
    this.host.notice(
      name
        ? `하이라이트 규칙 '${name}'의 검사가 너무 오래 걸려 껐습니다. 패턴을 고친 뒤 다시 켜세요.`
        : '하이라이트 검사가 너무 오래 걸려 이번 출력은 건너뛰었습니다.',
    );
    if (!id) return;
    const items = highlightLibrary().items.map((rule) =>
      rule.id === id ? { ...rule, enabled: false } : rule,
    );
    // The rule is already off for this run; only the next start would try it again.
    void saveHighlightRules(items).catch(() => {});
  }

  private apply(
    rules: HighlightRule[],
    lines: LogicalLine[],
    matches: Match[],
    anchor: IMarker,
    carried: boolean,
  ) {
    const lastLine = lines.length - 1;
    const fired = new Set<string>();
    const fresh = matches.filter((match) => {
      const key = `${rules[match.rule].id}:${match.start}:${lines[match.line].text.slice(match.start, match.end)}`;
      if (match.line === lastLine) fired.add(key);
      return !(carried && match.line === 0 && this.fired.has(key));
    });
    this.fired = fired;
    if (!anchor.isDisposed) this.paint(rules, lines, matches, anchor.line);
    this.act(rules, lines, fresh);
  }

  private paint(rules: HighlightRule[], lines: LogicalLine[], matches: Match[], top: number) {
    // The line still being written is drawn again, so its earlier colors go first.
    this.painted = this.painted.filter((item) => {
      const keep = !item.marker.isDisposed && item.marker.line < top;
      if (!keep) item.marker.dispose();
      return keep;
    });
    const spans = matches.flatMap((match) => {
      const color = rules[match.rule].color;
      if (!color) return [];
      return matchSpans(lines[match.line].cells, match.start, match.end).map((span) => ({
        ...span,
        color,
      }));
    });
    const cursor = this.cursorRow();
    for (const span of spans.slice(-batchDecorations)) {
      const marker = this.host.terminal.registerMarker(top + span.row - cursor);
      const decoration = this.decorate(marker, span.x, span.width, span.color);
      this.painted.push({ marker, decoration, color: span.color, x: span.x, width: span.width });
    }
    const excess = this.painted.length - liveDecorations;
    if (excess > 0) this.painted.splice(0, excess).forEach((item) => item.marker.dispose());
  }

  private decorate(marker: IMarker, x: number, width: number, color: HighlightColor) {
    if (marker.isDisposed) return undefined;
    return this.host.terminal.registerDecoration({
      marker,
      x,
      width,
      foregroundColor: highlightHex(this.theme, color),
    });
  }

  /** Notices and typed answers, once per rule per batch. Nothing runs while output replays. */
  private act(rules: HighlightRule[], lines: LogicalLine[], matches: Match[]) {
    if (this.host.replaying()) return;
    const seen = new Set<number>();
    for (const match of matches) {
      if (seen.has(match.rule)) continue;
      seen.add(match.rule);
      const rule = rules[match.rule];
      const line = lines[match.line].text;
      if (rule.notify) this.notify(rule, line);
      if (rule.send) void this.trigger(rule, rule.send.text);
    }
  }

  private notify(rule: HighlightRule, line: string) {
    const body = notificationBody(line.trim());
    this.host.notice(`하이라이트 '${rule.name}': ${body}`);
    const terminal = this.host.terminal;
    if (document.hasFocus() && document.activeElement === terminal.textarea) return;
    if (!appNotificationLimiter.allow(this.host, Date.now())) return;
    void call('notification_show', {
      title: `${this.host.sessionName()} — ${notificationBody(rule.name)}`,
      body,
    }).catch((e) => this.host.notice(errorText(e)));
  }

  private async trigger(rule: HighlightRule, text: string) {
    const now = Date.now();
    if (now - this.lastTrigger < triggerIntervalMs) return;
    this.lastTrigger = now;
    const id = this.host.connectionId();
    // Typing reaches every pane of a multi-input group, and a trigger answers one tab only.
    const status = await call<BroadcastStatus>('broadcast_status').catch(() => null);
    if (!status || (status.selected.length > 1 && status.selected.includes(id))) {
      this.host.notice(`트리거 '${rule.name}'는 동시 입력 중이라 입력을 보내지 않았습니다.`);
      return;
    }
    if (id !== this.host.connectionId() || this.host.replaying()) return;
    this.host.send(triggerInput(text));
    this.host.notice(`트리거 입력: ${rule.name}`);
  }
}
