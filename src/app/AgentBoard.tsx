import { useEffect, useRef, useState } from 'react';
import { programStateLabels } from '../features/terminal/programStatus';
import { modKey } from '../lib/platform';
import { boardCounts, elapsedText, type AgentRow } from './agentRows';
import type { AgentBoardState } from './useAgentBoard';
import '../features/terminal/agent.css';
import './agentBoard.css';

function Row({ row, now, choose }: { row: AgentRow; now: number; choose: () => void }) {
  return (
    <li>
      <button
        type="button"
        className="agent-row"
        title={row.git ? `${row.detail}\nGit ${row.git}` : row.detail}
        onClick={choose}
      >
        <span className={`program-status ${row.state}`}>{programStateLabels[row.state]}</span>
        <strong className="agent-row-name">{row.name}</strong>
        {row.window && <small className="agent-row-window">독립 창</small>}
        <span className="agent-row-git">{row.git}</span>
        <span className="agent-row-time">{elapsedText(now - row.since)}</span>
      </button>
    </li>
  );
}

/**
 * The status bar's count of tabs reporting a program state, shown only while some tab does.
 * It opens the list like the server monitor does, and a row takes the user to its tab or window.
 */
export function AgentBoard({ board }: { board: AgentBoardState }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const { rows } = board;
  const shown = open && rows.length > 0;
  useEffect(() => {
    if (!shown) return;
    // The elapsed times are coarse, so a redraw every half minute keeps them right.
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      clearInterval(timer);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [shown]);
  if (!rows.length) return null;
  const counts = boardCounts(rows);
  const summary = counts.map((c) => c.text).join(' · ');
  return (
    <div
      ref={root}
      className="agent-board"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && shown) {
          e.stopPropagation();
          setOpen(false);
          toggle.current?.focus();
        }
      }}
    >
      {shown && (
        <section className="agent-board-popover" aria-label="에이전트 현황">
          <ul>
            {rows.map((row) => (
              <Row
                key={row.key}
                row={row}
                now={now}
                choose={() => {
                  setOpen(false);
                  board.activate(row);
                }}
              />
            ))}
          </ul>
          <p className="agent-board-hint">다음 입력 대기로 이동 · {modKey('Shift+.')}</p>
        </section>
      )}
      <button
        ref={toggle}
        type="button"
        className="agent-board-toggle"
        aria-expanded={shown}
        aria-label={`에이전트 현황 · ${summary}`}
        title="탭별 프로그램 상태"
        onClick={() => {
          setNow(Date.now());
          setOpen((v) => !v);
        }}
      >
        {counts.map((c, i) => (
          <span key={c.state} className={`program-status ${c.state}`}>
            {i > 0 && <span className="agent-board-sep"> · </span>}
            {c.text}
          </span>
        ))}
      </button>
    </div>
  );
}
