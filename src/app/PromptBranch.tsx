import { useEffect, useRef, useState } from 'react';
import { changeCount, gitTooltip, hookBranch, syncText } from '../features/git/gitStatus';
import { useGitStatus } from '../features/git/useGitStatus';
import { commandMarksOf } from '../features/terminal/commandMarks';
import { useTerminalPreferences } from '../features/terminal/preferences';
import type { TerminalSession } from '../features/terminal/session';
import { useGitDisplay } from '../lib/gitDisplay';
import {
  badgeFits,
  badgeSuffix,
  badgeText,
  cells,
  lineEnd,
  promptShowsBranch,
} from './promptBadge';
import './promptBadge.css';

/** Lines above the input line searched for a prompt theme's own branch. */
const promptLinesAbove = 4;

type Shown = {
  text: string;
  suffix: string;
  stale: boolean;
  top: number;
  left: number;
  width: number;
  height: number;
  fontSize: number;
};
const sameShown = (a: Shown | null, b: Shown | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.text === b.text &&
    a.suffix === b.suffix &&
    a.stale === b.stale &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height &&
    a.fontSize === b.fontSize);

/**
 * The branch at the right of the line the shell waits for input on. It is drawn over the terminal
 * rather than into it, so copying, searching, session logs and screen readers never see it. tmux
 * draws its own screen, and a shell without the hook never reports a waiting prompt.
 */
export function PromptBranch({ session, active }: { session: TerminalSession; active: boolean }) {
  const git = useGitStatus(session);
  const { promptBranch } = useTerminalPreferences();
  const { detail } = useGitDisplay();
  const enabled = !!git && promptBranch !== 'off' && !session.profile.tmuxSession;
  const anchor = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const repo = git?.view && 'repo' in git.view ? git.view.repo : null;
  const answerTime = git?.answerTime ?? 0;
  useEffect(() => {
    const { terminal } = session;
    const marks = commandMarksOf(terminal);
    if (!enabled || !active || !marks) return;
    let frame = 0;
    const place = (): Shown | null => {
      const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
      const base = anchor.current?.getBoundingClientRect();
      if (!screen || !base || !marks.promptWaiting) return null;
      const box = screen.getBoundingClientRect();
      const buffer = terminal.buffer.active;
      const { cols, rows, options } = terminal;
      const cursor = buffer.baseY + buffer.cursorY;
      const row = cursor - buffer.viewportY;
      const line = buffer.getLine(cursor);
      if (!box.width || !line || line.isWrapped || row < 0 || row >= rows) return null;
      // The hook's report, or Git's answer where the hook could not read the name.
      const branch = marks.branch || (repo ? hookBranch(repo) : '');
      if (!branch) return null;
      const first = Math.max(
        marks.promptLine < 0 ? cursor : marks.promptLine,
        cursor - promptLinesAbove,
      );
      for (let y = first; y <= cursor; y++)
        if (promptShowsBranch(buffer.getLine(y)?.translateToString(true) ?? '', branch))
          return null;
      const count = detail !== 'branch' && repo?.entries.length ? changeCount(repo) : null;
      const suffix = badgeSuffix(count, detail === 'sync' && repo ? syncText(repo) : '');
      const text = badgeText(branch, suffix);
      const width = cells(text);
      if (!badgeFits(cols, Math.max(lineEnd(line, cols), buffer.cursorX), width)) return null;
      const cell = box.width / cols;
      const height = box.height / rows;
      return {
        text,
        suffix,
        stale: !!suffix && answerTime < marks.promptAt,
        top: box.top - base.top + row * height,
        left: box.left - base.left + (cols - width) * cell,
        width: width * cell,
        height,
        fontSize: options.fontSize ?? 14,
      };
    };
    const measure = () => {
      frame = 0;
      const next = place();
      setShown((last) => (sameShown(last, next) ? last : next));
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(measure);
    };
    schedule();
    const unsubscribe = marks.subscribe(schedule);
    const events = [
      terminal.onRender(schedule),
      terminal.onScroll(schedule),
      terminal.onResize(schedule),
      terminal.buffer.onBufferChange(schedule),
    ];
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      events.forEach((event) => event.dispose());
    };
  }, [session, enabled, active, repo, answerTime, detail]);
  if (!enabled || !active) return null;
  const name = shown?.text.slice(0, shown.text.length - shown.suffix.length);
  return (
    <div className="prompt-branch-anchor" ref={anchor} aria-hidden="true">
      {shown && (
        <span
          className="prompt-branch"
          style={{
            top: shown.top,
            left: shown.left,
            width: shown.width,
            height: shown.height,
            lineHeight: `${shown.height}px`,
            fontSize: shown.fontSize,
          }}
          title={repo ? gitTooltip(repo) : undefined}
          // Keeps the keyboard in the terminal.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => git?.refresh()}
        >
          {name}
          {shown.suffix && (
            <span className={shown.stale ? 'prompt-branch-stale' : undefined}>{shown.suffix}</span>
          )}
        </span>
      )}
    </div>
  );
}
