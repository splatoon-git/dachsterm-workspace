import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { GameId } from './catalog';

export function useBest(id: GameId, score: number, lower = false) {
  const [best, setBest] = useState(() => {
    try {
      const value = Number(localStorage.getItem(`dachsterm.games.v1.${id}`));
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  });
  if (score > 0 && (lower ? best === 0 || score < best : score > best)) setBest(score);
  useEffect(() => {
    try {
      localStorage.setItem(`dachsterm.games.v1.${id}`, String(best));
    } catch {
      /* Games work without storage. */
    }
  }, [id, best]);
  return best;
}
export function useRound(active: boolean) {
  const [phase, setPhase] = useState<'ready' | 'playing' | 'paused'>('ready');
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active && phase === 'playing') setPhase('paused');
  }
  const board = useRef<HTMLDivElement>(null);
  const pause = useCallback(() => setPhase((p) => (p === 'playing' ? 'paused' : p)), []);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) pause();
    };
    window.addEventListener('blur', pause);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', pause);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [pause]);
  const start = () => {
    setPhase('playing');
    board.current?.focus();
  };
  return {
    phase,
    board,
    pause,
    start,
    reset: () => {
      setPhase('ready');
      board.current?.focus();
    },
  };
}

export function Stats({
  score,
  best,
  label = '점수',
  bestLabel = '최고 기록',
  children,
}: {
  score: number;
  best: number;
  label?: string;
  bestLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="game-stats">
      <div>
        <span>{label}</span>
        <strong data-testid="game-score">{score.toLocaleString()}</strong>
      </div>
      <div>
        <span>{bestLabel}</span>
        <strong>{best ? best.toLocaleString() : '—'}</strong>
      </div>
      {children}
    </div>
  );
}

export function RoundControls({
  round,
  over,
  restart,
}: {
  round: Omit<ReturnType<typeof useRound>, 'board'>;
  over: boolean;
  restart: () => void;
}) {
  return (
    <div className="game-actions">
      {!over && (
        <button
          // WebKit does not focus a clicked button, so the board's blur would pause the round
          // first and this click would read as resume. Keeping focus on the board avoids that.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => (round.phase === 'playing' ? round.pause() : round.start())}
        >
          {round.phase === 'playing'
            ? '일시정지'
            : round.phase === 'paused'
              ? '계속하기'
              : '게임 시작'}
        </button>
      )}
      <button
        onClick={() => {
          restart();
          round.reset();
        }}
      >
        다시 시작
      </button>
    </div>
  );
}
export function phaseText(phase: string, over: boolean, won = false) {
  return over
    ? won
      ? '성공! 다시 도전해 보세요.'
      : '게임 종료 · 다시 도전해 보세요.'
    : phase === 'ready'
      ? '준비되면 게임 시작을 누르세요.'
      : phase === 'paused'
        ? '일시정지 · 계속하기를 누르세요.'
        : '플레이 중';
}

export function useBoardWidth(board: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const element = board.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0) setWidth(element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [board]);
  return width;
}
export function useFrame(running: boolean, tick: (dt: number) => void) {
  useEffect(() => {
    if (!running) return;
    let previous = performance.now();
    let frame: number;
    const animate = (now: number) => {
      tick((now - previous) / 1000);
      previous = now;
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [running, tick]);
}
