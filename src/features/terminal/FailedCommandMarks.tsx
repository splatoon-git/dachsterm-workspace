import { useEffect, useRef, useState } from 'react';
import type { TerminalSession } from './session';
import { commandMarksOf } from './commandMarks';
import './commandMarks.css';

type Shown = { line: number; exit: number; top: number; height: number };

/**
 * A bar at the left of each failed command's line. xterm's decorations need its proposed API,
 * which stays off, so this places its own marks over the screen from the marker lines.
 */
export function FailedCommandMarks({ session }: { session: TerminalSession }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Shown[]>([]);
  useEffect(() => {
    const { terminal } = session;
    const marks = commandMarksOf(terminal);
    if (!marks) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
      const buffer = terminal.buffer.active;
      const base = anchor.current?.getBoundingClientRect();
      if (!screen || !base || buffer.type !== 'normal' || !terminal.rows) return setShown([]);
      const box = screen.getBoundingClientRect();
      const height = box.height / terminal.rows;
      const top = buffer.viewportY;
      setShown(
        marks
          .failedLines()
          .filter(({ line }) => line >= top && line < top + terminal.rows)
          .map(({ line, exit }) => ({
            line,
            exit,
            top: box.top - base.top + (line - top) * height,
            height,
          })),
      );
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(measure);
    };
    schedule();
    const unsubscribe = marks.subscribe(schedule);
    const scrolled = terminal.onScroll(schedule);
    const resized = terminal.onResize(schedule);
    const buffer = terminal.buffer.onBufferChange(schedule);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      scrolled.dispose();
      resized.dispose();
      buffer.dispose();
    };
  }, [session]);
  return (
    <div className="command-marks" ref={anchor} aria-hidden="true">
      {shown.map((mark) => (
        <span
          key={mark.line}
          className="command-failed"
          style={{ top: mark.top, height: mark.height }}
          title={`실패한 명령 · 종료 코드 ${mark.exit}`}
        />
      ))}
    </div>
  );
}
