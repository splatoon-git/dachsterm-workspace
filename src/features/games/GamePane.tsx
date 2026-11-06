import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { games, type GameId } from './catalog';
import {
  BLOCK_SHAPES,
  MINE_COUNT,
  ghostPiece,
  moveBlocks,
  moveTiles,
  newBlocks,
  newMines,
  newSnake,
  newTiles,
  playMines,
  stepSnake,
  turnSnake,
  type BlockAction,
  type Direction,
} from './engines';
import { useBest, useRound, Stats, RoundControls, phaseText } from './shared';
import { DachsSnackGame } from './DachsGames';
import { DachsAdventureGame } from './AdventureGame';
import { SurvivorGame, type SurvivorCloseRegistration } from './survivor/SurvivorGame';
import './games.css';

const directions: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

function useClock(running: boolean, delay: number, tick: () => void) {
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(tick, delay);
    return () => window.clearInterval(timer);
  }, [running, delay, tick]);
}
function DirectionPad({
  move,
  verticalLabel = '위로',
}: {
  move: (direction: Direction) => void;
  verticalLabel?: string;
}) {
  return (
    <div className="game-direction-pad" aria-label="방향 조작">
      <button aria-label={verticalLabel} onClick={() => move('up')}>
        ↑
      </button>
      <div>
        <button aria-label="왼쪽으로" onClick={() => move('left')}>
          ←
        </button>
        <button aria-label="아래로" onClick={() => move('down')}>
          ↓
        </button>
        <button aria-label="오른쪽으로" onClick={() => move('right')}>
          →
        </button>
      </div>
    </div>
  );
}
function BlocksGame({ active }: { active: boolean }) {
  const [state, setState] = useState(newBlocks);
  const { board, ...round } = useRound(active);
  const best = useBest('blocks', state.score);
  const playing = round.phase === 'playing' && !state.over;
  const tick = useCallback(() => setState((s) => moveBlocks(s, 'tick')), []);
  useClock(playing, Math.max(100, 700 - Math.floor(state.lines / 10) * 65), tick);
  const move = (action: BlockAction) => {
    if (playing) setState((s) => moveBlocks(s, action));
    board.current?.focus();
  };
  const cells = state.board.map((row) => [...row]);
  const ghost = ghostPiece(state);
  if (!state.over) {
    ghost.cells.forEach((row, y) =>
      row.forEach((cell, x) => {
        if (cell) cells[ghost.y + y][ghost.x + x] = -1;
      }),
    );
    state.piece.cells.forEach((row, y) =>
      row.forEach((cell, x) => {
        if (cell) cells[state.piece.y + y][state.piece.x + x] = cell;
      }),
    );
  }
  return (
    <section
      className="game-play"
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) round.pause();
      }}
    >
      <Stats score={state.score} best={best}>
        <div>
          <span>줄 / 레벨</span>
          <strong>
            {state.lines} / {1 + Math.floor(state.lines / 10)}
          </strong>
        </div>
      </Stats>
      <div className="game-stage">
        <div
          className="game-board blocks-board"
          ref={board}
          tabIndex={0}
          role="group"
          aria-label="블록 퍼즐 게임판"
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
            const action: Record<string, BlockAction> = {
              ArrowLeft: 'left',
              ArrowRight: 'right',
              ArrowDown: 'down',
              ArrowUp: 'rotate',
              ' ': 'drop',
            };
            if (action[e.key]) {
              e.preventDefault();
              e.stopPropagation();
              if (!e.repeat || e.key !== ' ') move(action[e.key]);
            }
            if (e.key.toLowerCase() === 'p') {
              e.preventDefault();
              round.pause();
            }
          }}
        >
          {cells.flatMap((row, y) =>
            row.map((cell, x) => <span key={`${x}-${y}`} className={`block-cell block-${cell}`} />),
          )}
        </div>
        <aside className="game-guide">
          <h3>다음 블록</h3>
          <div
            className="next-block"
            style={{ '--columns': BLOCK_SHAPES[state.bag[0] ?? 0][0].length } as CSSProperties}
            aria-label={state.bag.length ? '다음 블록 미리보기' : '다음 묶음에서 무작위 선택'}
          >
            {state.bag.length ? (
              BLOCK_SHAPES[state.bag[0]]
                .flat()
                .map((cell, i) => <span key={i} className={`block-cell block-${cell}`} />)
            ) : (
              <span>?</span>
            )}
          </div>
          <p>
            ← → 이동
            <br />↑ 회전 · ↓ 내리기
            <br />
            Space 즉시 떨어뜨리기
            <br />P 일시정지
          </p>
          <DirectionPad verticalLabel="블록 회전" move={(d) => move(d === 'up' ? 'rotate' : d)} />
          <button onClick={() => move('drop')}>즉시 떨어뜨리기</button>
        </aside>
      </div>
      <p className="game-status" role="status">
        {phaseText(round.phase, state.over)}
      </p>
      <RoundControls round={round} over={state.over} restart={() => setState(newBlocks())} />
    </section>
  );
}
function SnakeGame({ active }: { active: boolean }) {
  const [state, setState] = useState(newSnake);
  const { board, ...round } = useRound(active);
  const best = useBest('snake', state.score);
  const playing = round.phase === 'playing' && !state.over;
  const tick = useCallback(() => setState((s) => stepSnake(s)), []);
  useClock(playing, Math.max(85, 200 - state.score), tick);
  const move = (direction: Direction) => {
    if (playing) setState((s) => turnSnake(s, direction));
    board.current?.focus();
  };
  return (
    <section
      className="game-play"
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) round.pause();
      }}
    >
      <Stats score={state.score} best={best} />
      <div className="game-stage">
        <div
          className="game-board snake-board"
          ref={board}
          tabIndex={0}
          role="group"
          aria-label="스네이크 게임판"
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
            if (directions[e.key]) {
              e.preventDefault();
              e.stopPropagation();
              move(directions[e.key]);
            }
            if (e.key.toLowerCase() === 'p') {
              e.preventDefault();
              round.pause();
            }
          }}
        >
          {Array.from({ length: 256 }, (_, i) => {
            const x = i % 16,
              y = Math.floor(i / 16);
            const snake = state.body.findIndex((p) => p.x === x && p.y === y);
            const food = state.food?.x === x && state.food?.y === y;
            return (
              <span
                key={i}
                className={`snake-cell ${snake === 0 ? 'snake-head' : snake > 0 ? 'snake-body' : food ? 'snake-food' : ''}`}
              >
                {snake === 0 ? '•' : food ? '◆' : ''}
              </span>
            );
          })}
        </div>
        <aside className="game-guide">
          <h3>조작</h3>
          <p>방향키로 움직여 먹이를 모으세요. 벽이나 몸에 닿으면 끝납니다.</p>
          <p>먹이 +10점 · P 일시정지</p>
          <DirectionPad move={move} />
        </aside>
      </div>
      <p className="game-status" role="status">
        {phaseText(round.phase, state.over, state.won)}
      </p>
      <RoundControls round={round} over={state.over} restart={() => setState(newSnake())} />
    </section>
  );
}
function TilesGame() {
  const [state, setState] = useState(newTiles);
  const board = useRef<HTMLDivElement>(null);
  const best = useBest('tiles', state.score);
  const move = (direction: Direction) => {
    setState((s) => moveTiles(s, direction));
    board.current?.focus();
  };
  return (
    <section className="game-play">
      <Stats score={state.score} best={best} />
      <div className="game-stage">
        <div
          ref={board}
          className="game-board tiles-board"
          tabIndex={0}
          role="group"
          aria-label="2048 게임판"
          onKeyDown={(e) => {
            if (
              e.target === e.currentTarget &&
              directions[e.key] &&
              !e.ctrlKey &&
              !e.metaKey &&
              !e.altKey
            ) {
              e.preventDefault();
              e.stopPropagation();
              move(directions[e.key]);
            }
          }}
        >
          {state.cells.map((n, i) => (
            <span
              key={i}
              className={`number-tile tile-${n ? Math.min(Math.log2(n), 4) : 0}`}
              aria-label={`${Math.floor(i / 4) + 1}행 ${(i % 4) + 1}열 ${n || '빈칸'}`}
            >
              {n || ''}
            </span>
          ))}
        </div>
        <aside className="game-guide">
          <h3>조작</h3>
          <p>게임판을 클릭하고 방향키를 누르세요. 같은 숫자가 만나면 합쳐집니다.</p>
          <p>2048을 만든 뒤에도 계속 도전할 수 있어요.</p>
          <DirectionPad move={move} />
        </aside>
      </div>
      <p className="game-status" role="status">
        {state.over
          ? '더 이상 움직일 수 없습니다. 다시 도전해 보세요.'
          : state.won
            ? '2048 달성! 더 큰 숫자에 도전하세요.'
            : '방향키 또는 화살표 버튼으로 시작하세요.'}
      </p>
      <div className="game-actions">
        <button
          onClick={() => {
            setState(newTiles());
            board.current?.focus();
          }}
        >
          다시 시작
        </button>
      </div>
    </section>
  );
}
function MinesGame() {
  const [state, setState] = useState(newMines);
  const [flagMode, setFlagMode] = useState(false);
  const [focusedCell, setFocusedCell] = useState(0);
  const best = useBest('mines', state.won ? state.moves : 0, true);
  const flags = state.cells.filter((c) => c.flag).length;
  return (
    <section className="game-play">
      <Stats score={state.moves} best={best} label="열기 횟수" bestLabel="최소 클릭 승리">
        <div>
          <span>지뢰 / 깃발</span>
          <strong>
            {MINE_COUNT} / {flags}
          </strong>
        </div>
      </Stats>
      <div className="game-stage">
        <div className="game-board mines-board" role="group" aria-label="지뢰찾기 게임판">
          {state.cells.map((cell, i) => (
            <button
              key={i}
              tabIndex={focusedCell === i ? 0 : -1}
              onFocus={() => setFocusedCell(i)}
              className={`mine-cell ${cell.open ? 'opened' : ''} ${cell.open && cell.mine ? 'exploded' : ''}`}
              aria-disabled={state.over || cell.open}
              aria-label={`${Math.floor(i / 9) + 1}행 ${(i % 9) + 1}열 ${cell.open ? (cell.mine ? '지뢰' : cell.adjacent ? `주변 지뢰 ${cell.adjacent}개` : '빈칸') : cell.flag ? '깃발' : '닫힘'}`}
              onClick={(e) => setState((s) => playMines(s, i, flagMode || e.shiftKey))}
              onContextMenu={(e) => {
                e.preventDefault();
                setState((s) => playMines(s, i, true));
              }}
              onKeyDown={(e) => {
                if (e.key.toLowerCase() === 'f') {
                  e.preventDefault();
                  setState((s) => playMines(s, i, true));
                }
                if (directions[e.key]) {
                  e.preventDefault();
                  const x = i % 9,
                    y = Math.floor(i / 9);
                  const next =
                    e.key === 'ArrowLeft'
                      ? y * 9 + Math.max(0, x - 1)
                      : e.key === 'ArrowRight'
                        ? y * 9 + Math.min(8, x + 1)
                        : e.key === 'ArrowUp'
                          ? Math.max(0, y - 1) * 9 + x
                          : Math.min(8, y + 1) * 9 + x;
                  (e.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
                }
              }}
            >
              {cell.open ? (cell.mine ? '✹' : cell.adjacent || '') : cell.flag ? '⚑' : ''}
            </button>
          ))}
        </div>
        <aside className="game-guide">
          <h3>9 × 9 · 지뢰 10개</h3>
          <p>첫 칸과 그 주변은 안전합니다. 숫자는 주변 8칸의 지뢰 수예요.</p>
          <p>
            클릭 / Enter: 열기
            <br />
            우클릭 / F: 깃발
            <br />
            방향키: 칸 이동
          </p>
          <button aria-pressed={flagMode} onClick={() => setFlagMode((v) => !v)}>
            깃발 모드 {flagMode ? '켜짐' : '꺼짐'}
          </button>
        </aside>
      </div>
      <p className="game-status" role="status">
        {state.won
          ? '성공! 모든 안전한 칸을 찾았습니다.'
          : state.over
            ? '지뢰를 밟았습니다. 다시 도전해 보세요.'
            : '지뢰를 피해 모든 안전한 칸을 열어보세요.'}
      </p>
      <div className="game-actions">
        <button
          onClick={() => {
            setState(newMines());
            setFlagMode(false);
          }}
        >
          다시 시작
        </button>
      </div>
    </section>
  );
}
export default function GamePane({
  game,
  active,
  leave,
  registerSurvivorClose,
}: {
  game: GameId;
  active: boolean;
  leave: () => void;
  registerSurvivorClose?: SurvivorCloseRegistration;
}) {
  const pane = useRef<HTMLElement>(null);
  useEffect(() => {
    if (active && game !== 'survivor')
      pane.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, [active, game]);
  return (
    <section
      ref={pane}
      className="game-terminal"
      role="tabpanel"
      id={`game-panel-${game}`}
      aria-labelledby={`game-tab-${game}`}
      hidden={!active}
      inert={!active}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          leave();
        }
      }}
    >
      <div className="game-terminal-heading">
        <span>
          {games.find((item) => item.id === game)?.title} <small>/ local</small>
        </span>
        <button onClick={leave}>
          작업으로 돌아가기 <kbd>Esc</kbd>
        </button>
      </div>
      {game === 'blocks' ? (
        <BlocksGame active={active} />
      ) : game === 'snake' ? (
        <SnakeGame active={active} />
      ) : game === 'tiles' ? (
        <TilesGame />
      ) : game === 'snack' ? (
        <DachsSnackGame active={active} />
      ) : game === 'adventure' ? (
        <DachsAdventureGame active={active} />
      ) : game === 'survivor' ? (
        <SurvivorGame active={active} registerClose={registerSurvivorClose} />
      ) : (
        <MinesGame />
      )}
      <p className="games-footnote">
        탭 전환 시 현재 판 유지 · 탭을 닫으면 종료 · 기록은 로컬 저장
      </p>
    </section>
  );
}
