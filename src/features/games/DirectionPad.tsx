import type { Direction } from './engines';

export function DirectionPad({
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
