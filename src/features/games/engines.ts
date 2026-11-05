export type Random = () => number;
export type Direction = 'left' | 'right' | 'up' | 'down';
export type Point = { x: number; y: number };
const vectors: Record<Direction, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};
function shuffled<T>(items: T[], random: Random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Falling blocks: a seven-piece bag, collision checks and line clearing.
export const BLOCK_SHAPES = [
  [[1, 1, 1, 1]],
  [
    [2, 2],
    [2, 2],
  ],
  [
    [0, 3, 0],
    [3, 3, 3],
  ],
  [
    [0, 4, 4],
    [4, 4, 0],
  ],
  [
    [5, 5, 0],
    [0, 5, 5],
  ],
  [
    [6, 0, 0],
    [6, 6, 6],
  ],
  [
    [0, 0, 7],
    [7, 7, 7],
  ],
];
export type Piece = Point & { cells: number[][] };
export type Blocks = {
  board: number[][];
  piece: Piece;
  bag: number[];
  score: number;
  lines: number;
  over: boolean;
};
function spawn(index: number): Piece {
  const cells = BLOCK_SHAPES[index].map((row) => [...row]);
  return { cells, x: Math.floor((10 - cells[0].length) / 2), y: 0 };
}
export function newBlocks(random: Random = Math.random): Blocks {
  const bag = shuffled([0, 1, 2, 3, 4, 5, 6], random);
  return {
    board: Array.from({ length: 20 }, () => Array<number>(10).fill(0)),
    piece: spawn(bag[0]),
    bag: bag.slice(1),
    score: 0,
    lines: 0,
    over: false,
  };
}
export function fits(board: number[][], piece: Piece): boolean {
  return piece.cells.every((row, y) =>
    row.every(
      (cell, x) =>
        !cell ||
        (piece.x + x >= 0 &&
          piece.x + x < 10 &&
          piece.y + y >= 0 &&
          piece.y + y < 20 &&
          board[piece.y + y][piece.x + x] === 0),
    ),
  );
}
export function ghostPiece(state: Blocks): Piece {
  let piece = state.piece;
  while (fits(state.board, { ...piece, y: piece.y + 1 })) piece = { ...piece, y: piece.y + 1 };
  return piece;
}
function lockBlocks(state: Blocks, random: Random): Blocks {
  const board = state.board.map((row) => [...row]);
  state.piece.cells.forEach((row, y) =>
    row.forEach((cell, x) => {
      if (cell) board[state.piece.y + y][state.piece.x + x] = cell;
    }),
  );
  const remaining = board.filter((row) => row.some((cell) => cell === 0));
  const cleared = 20 - remaining.length;
  while (remaining.length < 20) remaining.unshift(Array<number>(10).fill(0));
  const bag = state.bag.length ? state.bag : shuffled([0, 1, 2, 3, 4, 5, 6], random);
  const piece = spawn(bag[0]);
  return {
    board: remaining,
    piece,
    bag: bag.slice(1),
    score: state.score + [0, 100, 300, 500, 800][cleared] * (1 + Math.floor(state.lines / 10)),
    lines: state.lines + cleared,
    over: !fits(remaining, piece),
  };
}
export type BlockAction = 'left' | 'right' | 'rotate' | 'down' | 'drop' | 'tick';
export function moveBlocks(
  state: Blocks,
  action: BlockAction,
  random: Random = Math.random,
): Blocks {
  if (state.over) return state;
  if (action === 'drop') {
    const piece = ghostPiece(state);
    return lockBlocks(
      { ...state, piece, score: state.score + 2 * (piece.y - state.piece.y) },
      random,
    );
  }
  if (action === 'rotate') {
    const cells = state.piece.cells[0].map((_, x) =>
      state.piece.cells.map((row) => row[x]).reverse(),
    );
    for (const dy of [0, -1])
      for (const dx of [0, -1, 1, -2, 2]) {
        const piece = { cells, x: state.piece.x + dx, y: state.piece.y + dy };
        if (fits(state.board, piece)) return { ...state, piece };
      }
    return state;
  }
  const piece = {
    ...state.piece,
    x: state.piece.x + (action === 'left' ? -1 : action === 'right' ? 1 : 0),
    y: state.piece.y + (action === 'down' || action === 'tick' ? 1 : 0),
  };
  if (fits(state.board, piece))
    return { ...state, piece, score: state.score + (action === 'down' ? 1 : 0) };
  return action === 'down' || action === 'tick' ? lockBlocks(state, random) : state;
}

export type Snake = {
  body: Point[];
  direction: Direction;
  pending: Direction;
  food: Point | null;
  score: number;
  over: boolean;
  won: boolean;
};
function snakeFood(body: Point[], random: Random): Point | null {
  const free: Point[] = [];
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      if (!body.some((p) => p.x === x && p.y === y)) free.push({ x, y });
    }
  return free.length ? free[Math.floor(random() * free.length)] : null;
}
export function newSnake(random: Random = Math.random): Snake {
  const body = [
    { x: 7, y: 8 },
    { x: 6, y: 8 },
    { x: 5, y: 8 },
  ];
  return {
    body,
    direction: 'right',
    pending: 'right',
    food: snakeFood(body, random),
    score: 0,
    over: false,
    won: false,
  };
}
export function turnSnake(state: Snake, direction: Direction): Snake {
  const a = vectors[state.direction],
    b = vectors[direction];
  if (state.over || (a.x + b.x === 0 && a.y + b.y === 0)) return state;
  return { ...state, pending: direction };
}
export function stepSnake(state: Snake, random: Random = Math.random): Snake {
  if (state.over) return state;
  const delta = vectors[state.pending];
  const head = { x: state.body[0].x + delta.x, y: state.body[0].y + delta.y };
  const eating = head.x === state.food?.x && head.y === state.food?.y;
  const tail = eating ? state.body : state.body.slice(0, -1);
  if (
    head.x < 0 ||
    head.x >= 16 ||
    head.y < 0 ||
    head.y >= 16 ||
    tail.some((p) => p.x === head.x && p.y === head.y)
  ) {
    return { ...state, over: true };
  }
  const body = [head, ...tail];
  const food = eating ? snakeFood(body, random) : state.food;
  return {
    ...state,
    body,
    food,
    direction: state.pending,
    score: state.score + (eating ? 10 : 0),
    over: !food,
    won: !food,
  };
}

export type Tiles = { cells: number[]; score: number; won: boolean; over: boolean };
function addTile(cells: number[], random: Random): number[] {
  const free = cells.flatMap((n, i) => (n === 0 ? [i] : []));
  if (!free.length) return cells;
  const result = [...cells];
  result[free[Math.floor(random() * free.length)]] = random() < 0.9 ? 2 : 4;
  return result;
}
export function newTiles(random: Random = Math.random): Tiles {
  return {
    cells: addTile(addTile(Array<number>(16).fill(0), random), random),
    score: 0,
    won: false,
    over: false,
  };
}
export function tilesOver(cells: number[]): boolean {
  return cells.every(
    (n, i) => n !== 0 && (i % 4 === 3 || n !== cells[i + 1]) && (i >= 12 || n !== cells[i + 4]),
  );
}
export function moveTiles(state: Tiles, direction: Direction, random: Random = Math.random): Tiles {
  if (state.over) return state;
  const cells = [...state.cells];
  let score = state.score;
  for (let line = 0; line < 4; line++) {
    const indices = Array.from({ length: 4 }, (_, i) =>
      direction === 'left'
        ? line * 4 + i
        : direction === 'right'
          ? line * 4 + 3 - i
          : direction === 'up'
            ? i * 4 + line
            : (3 - i) * 4 + line,
    );
    const values = indices.map((i) => cells[i]).filter(Boolean);
    const merged: number[] = [];
    for (let i = 0; i < values.length; i++) {
      if (values[i] === values[i + 1]) {
        merged.push(values[i] * 2);
        score += values[i] * 2;
        i++;
      } else merged.push(values[i]);
    }
    indices.forEach((index, i) => {
      cells[index] = merged[i] ?? 0;
    });
  }
  if (cells.every((n, i) => n === state.cells[i])) return state;
  const next = addTile(cells, random);
  return {
    cells: next,
    score,
    won: state.won || next.some((n) => n >= 2048),
    over: tilesOver(next),
  };
}

export type MineCell = { mine: boolean; adjacent: number; open: boolean; flag: boolean };
export type Mines = {
  cells: MineCell[];
  ready: boolean;
  over: boolean;
  won: boolean;
  moves: number;
};
export const MINE_COUNT = 10;
export function newMines(): Mines {
  return {
    cells: Array.from({ length: 81 }, () => ({
      mine: false,
      adjacent: 0,
      open: false,
      flag: false,
    })),
    ready: false,
    over: false,
    won: false,
    moves: 0,
  };
}
export function neighbors(index: number): number[] {
  const result: number[] = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = (index % 9) + dx,
        y = Math.floor(index / 9) + dy;
      if ((dx || dy) && x >= 0 && x < 9 && y >= 0 && y < 9) result.push(y * 9 + x);
    }
  return result;
}
export function playMines(
  state: Mines,
  index: number,
  flag = false,
  random: Random = Math.random,
): Mines {
  if (state.over || index < 0 || index >= 81 || state.cells[index].open) return state;
  const cells = state.cells.map((c) => ({ ...c }));
  if (flag) {
    cells[index].flag = !cells[index].flag;
    return { ...state, cells };
  }
  if (cells[index].flag) return state;
  if (!state.ready) {
    const safe = new Set([index, ...neighbors(index)]);
    shuffled(
      cells.flatMap((_, i) => (safe.has(i) ? [] : [i])),
      random,
    )
      .slice(0, MINE_COUNT)
      .forEach((i) => {
        cells[i].mine = true;
      });
    cells.forEach((cell, i) => {
      cell.adjacent = neighbors(i).filter((j) => cells[j].mine).length;
    });
  }
  if (cells[index].mine) {
    cells.forEach((c) => {
      if (c.mine) c.open = true;
    });
    return { ...state, cells, ready: true, over: true, moves: state.moves + 1 };
  }
  const stack = [index];
  while (stack.length) {
    const i = stack.pop()!;
    const cell = cells[i];
    if (cell.open || cell.flag || cell.mine) continue;
    cell.open = true;
    if (!cell.adjacent) stack.push(...neighbors(i));
  }
  const won = cells.every((c) => c.mine || c.open);
  if (won)
    cells.forEach((c) => {
      if (c.mine) c.flag = true;
    });
  return { cells, ready: true, won, over: won, moves: state.moves + 1 };
}
