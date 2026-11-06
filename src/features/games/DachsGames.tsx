import { useCallback, useEffect, useRef, useState } from 'react';
import { SnackScene, TreatShape } from './SnackScene';
import './snack.css';
import {
  SNACK_SECONDS,
  newSnack,
  stepSnack,
  resizeSnack,
  type SnackInput,
  snackMotion,
} from './dachsEngines';
import {
  RoundControls,
  Stats,
  phaseText,
  useBest,
  useRound,
  useBoardWidth,
  useFrame,
} from './shared';

export function DachsSnackGame({ active }: { active: boolean }) {
  const [state, setState] = useState(newSnack);
  const { board, ...round } = useRound(active);
  const actualWidth = useBoardWidth(board);
  const width = Math.max(360, actualWidth);
  const [previousWidth, setPreviousWidth] = useState(600);
  if (previousWidth !== width) {
    setPreviousWidth(width);
    setState((s) => resizeSnack(s, previousWidth, width));
  }
  const best = useBest('snack', state.score);
  const playing = active && round.phase === 'playing' && !state.over;
  const input = useRef<SnackInput>({ direction: 0, target: null });
  const held = useRef(new Set<string>());
  const pointers = useRef(new Map<number, number>());
  const clear = useCallback(() => {
    input.current = { direction: 0, target: null };
    held.current.clear();
    pointers.current.clear();
  }, []);
  useEffect(() => {
    if (!playing) clear();
  }, [playing, clear]);
  useEffect(clear, [width, clear]);
  const tick = useCallback(
    (dt: number) => {
      // Keep React's updater pure when StrictMode replays it.
      const entropy = [Math.random(), Math.random(), Math.random()];
      const frameInput = { ...input.current };
      setState((s) => {
        let index = 0;
        return stepSnack(s, dt, width, frameInput, () => entropy[index++ % entropy.length]);
      });
    },
    [width],
  );
  useFrame(playing, tick);
  const keys = () => {
    input.current.direction =
      Number(
        held.current.has('ArrowRight') ||
          held.current.has('d') ||
          [...pointers.current.values()].includes(1),
      ) -
      Number(
        held.current.has('ArrowLeft') ||
          held.current.has('a') ||
          [...pointers.current.values()].includes(-1),
      );
    input.current.target = null;
  };
  const pointerX = (clientX: number) => {
    const rect = board.current!.getBoundingClientRect();
    return ((clientX - rect.left - board.current!.clientLeft) / board.current!.clientWidth) * width;
  };
  return (
    <section
      className="game-play dachs-play snack-play"
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          clear();
          round.pause();
        }
      }}
      onKeyUp={(e) => {
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (['ArrowLeft', 'ArrowRight', 'a', 'd'].includes(key)) {
          e.stopPropagation();
          held.current.delete(key);
          keys();
        }
      }}
    >
      <div className="snack-heading">
        <span>작은 정원의 간식 시간</span>
        <span>
          {state.elapsed < 15
            ? '01 / 가볍게 냠냠'
            : state.elapsed < 30
              ? '02 / 간식 소나기'
              : '03 / 마지막 한 입'}
        </span>
      </div>
      <Stats score={state.score} best={best}>
        <div>
          <span>남은 시간</span>
          <strong data-testid="snack-time">{Math.ceil(SNACK_SECONDS - state.elapsed)}초</strong>
        </div>
        <div>
          <span>목숨</span>
          <strong data-testid="snack-lives" aria-label={`목숨 ${state.lives} / 3`}>
            {'♥'.repeat(state.lives)}
            {'♡'.repeat(3 - state.lives)}
          </strong>
        </div>
        <div>
          <span>연속 받기</span>
          <strong data-testid="snack-combo">{state.combo}개</strong>
        </div>
      </Stats>
      <div
        className="snack-clock"
        role="progressbar"
        aria-label="남은 간식 시간"
        aria-valuemin={0}
        aria-valuemax={45}
        aria-valuenow={Math.ceil(SNACK_SECONDS - state.elapsed)}
      >
        <span style={{ width: `${100 * (1 - state.elapsed / SNACK_SECONDS)}%` }} />
      </div>
      <div
        ref={board}
        className="game-board dachs-board snack-board"
        data-x={Math.round(state.x)}
        data-motion={snackMotion(state)}
        data-facing={state.facing}
        tabIndex={0}
        role="group"
        aria-label="닥스의 간식 타임 게임판"
        onBlur={clear}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
          const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
          if (['ArrowLeft', 'ArrowRight', 'a', 'd'].includes(key)) {
            e.preventDefault();
            e.stopPropagation();
            if (playing) {
              held.current.add(key);
              keys();
            }
          }
          if (key === 'p') {
            e.preventDefault();
            e.stopPropagation();
            clear();
            round.pause();
          }
        }}
        onPointerDown={(e) => {
          board.current?.focus();
          if (!playing) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          input.current.target = pointerX(e.clientX);
          input.current.direction = 0;
        }}
        onPointerMove={(e) => {
          if (playing && e.currentTarget.hasPointerCapture(e.pointerId))
            input.current.target = pointerX(e.clientX);
        }}
        onPointerCancel={clear}
      >
        <SnackScene state={state} width={width} phase={round.phase} />
      </div>
      <div className="snack-legend" aria-label="간식 규칙">
        {(['bone', 'star', 'onion'] as const).map((kind) => (
          <span key={kind}>
            <svg viewBox="-25 -26 50 50" aria-hidden="true">
              <TreatShape kind={kind} />
            </svg>
            {kind === 'bone' ? '간식 +10' : kind === 'star' ? '별 +30' : '양파는 피하기'}
          </span>
        ))}
      </div>
      <p className="dachs-help">
        ← → / A D / 드래그로 이동 · P 일시정지
        <br />
        놓친 간식은 감점 없이 연속 기록만 초기화돼요.
      </p>
      <div className="game-actions dachs-touch-controls">
        {([-1, 1] as const).map((direction) => (
          <button
            key={direction}
            disabled={!playing}
            aria-label={direction < 0 ? '왼쪽으로' : '오른쪽으로'}
            onPointerDown={(e) => {
              e.preventDefault();
              board.current?.focus();
              e.currentTarget.setPointerCapture(e.pointerId);
              pointers.current.set(e.pointerId, direction);
              keys();
            }}
            onPointerUp={(e) => {
              pointers.current.delete(e.pointerId);
              keys();
            }}
            onPointerCancel={(e) => {
              pointers.current.delete(e.pointerId);
              keys();
            }}
            onLostPointerCapture={(e) => {
              pointers.current.delete(e.pointerId);
              keys();
            }}
            onClick={(e) => {
              if (e.detail === 0 && playing) {
                setState((s) => stepSnack(s, 0.05, width, { direction, target: null }));
                board.current?.focus();
              }
            }}
          >
            {direction < 0 ? '← 왼쪽' : '오른쪽 →'}
          </button>
        ))}
      </div>
      <p className="game-status" role="status">
        {state.over && state.lives > 0
          ? '45초 간식 사냥 완료! 다시 도전해 보세요.'
          : phaseText(round.phase, state.over)}
      </p>
      <RoundControls
        round={round}
        over={state.over}
        restart={() => {
          clear();
          setState(newSnack(width));
        }}
      />
    </section>
  );
}
