import { describe, expect, it } from 'vitest';
import {
  fits,
  ghostPiece,
  moveBlocks,
  moveTiles,
  neighbors,
  newBlocks,
  newMines,
  newSnake,
  playMines,
  stepSnake,
  tilesOver,
  turnSnake,
  type Tiles,
} from './engines';
const fixed = () => 0.25;

describe('falling blocks', () => {
  it('stops at walls, rotates within bounds and lands at the ghost position', () => {
    let state = newBlocks(fixed);
    for (let i = 0; i < 20; i++) state = moveBlocks(state, 'left', fixed);
    expect(state.piece.x).toBe(0);
    state = moveBlocks(state, 'rotate', fixed);
    expect(fits(state.board, state.piece)).toBe(true);
    const ghost = ghostPiece(state);
    expect(fits(state.board, { ...ghost, y: ghost.y + 1 })).toBe(false);
    const next = moveBlocks(state, 'drop', fixed);
    expect(next.board.flat().filter(Boolean)).toHaveLength(4);
    expect(next.score).toBe((ghost.y - state.piece.y) * 2);
  });
  it('clears lines together and ends when the next spawn is blocked', () => {
    const state = newBlocks(fixed);
    state.board[19] = [1, 1, 1, 0, 0, 0, 0, 1, 1, 1];
    state.piece = { x: 3, y: 19, cells: [[1, 1, 1, 1]] };
    const next = moveBlocks(state, 'tick', fixed);
    expect(next.lines).toBe(1);
    expect(next.score).toBe(100);
    expect(next.board.flat().every((n) => n === 0)).toBe(true);
    state.board[0] = Array(10).fill(1);
    state.board[0][0] = 0; // Block spawn without making this a completed row.
    expect(moveBlocks(state, 'tick', fixed).over).toBe(true);
  });
  it('uses each of seven shapes once per bag', () => {
    const state = newBlocks(fixed);
    const first = state.piece.cells.flat().find(Boolean)! - 1;
    expect(new Set([first, ...state.bag]).size).toBe(7);
  });
});

describe('snake', () => {
  it('rejects reversing even when two turns arrive before the next tick', () => {
    const state = turnSnake(turnSnake(newSnake(fixed), 'up'), 'left');
    expect(state.pending).toBe('up');
    expect(stepSnake(state, fixed).body[0]).toEqual({ x: 7, y: 7 });
  });
  it('grows on food, spawns food outside the body and stops at a wall', () => {
    const state = newSnake(fixed);
    state.food = { x: 8, y: 8 };
    const next = stepSnake(state, fixed);
    expect(next.body).toHaveLength(4);
    expect(next.score).toBe(10);
    expect(next.body).not.toContainEqual(next.food);
    next.body[0] = { x: 15, y: 8 };
    expect(stepSnake(next, fixed).over).toBe(true);
  });
  it('permits entering the vacated tail but detects a body collision', () => {
    const state = newSnake(fixed);
    state.body = [
      { x: 2, y: 2 },
      { x: 2, y: 3 },
      { x: 1, y: 3 },
      { x: 1, y: 2 },
    ];
    state.direction = 'up';
    state.pending = 'left';
    expect(stepSnake(state, fixed).over).toBe(false);
    state.pending = 'down';
    expect(stepSnake(state, fixed).over).toBe(true);
  });
});

function tiles(cells: number[]): Tiles {
  return { cells, score: 0, won: false, over: false };
}
describe('2048', () => {
  it('merges each tile once and awards the resulting values', () => {
    const state = tiles([2, 2, 2, 2, ...Array(12).fill(0)]);
    const next = moveTiles(state, 'left', fixed);
    expect(next.cells.slice(0, 4)).toEqual([4, 4, 0, 0]);
    expect(next.score).toBe(8);
    expect(state.cells.slice(0, 4)).toEqual([2, 2, 2, 2]);
  });
  it('does not spawn a new tile for a no-op and handles every direction', () => {
    const state = tiles([2, ...Array(15).fill(0)]);
    expect(moveTiles(state, 'left', fixed)).toBe(state);
    expect(moveTiles(state, 'right', fixed).cells[3]).toBe(2);
    expect(moveTiles(state, 'down', fixed).cells[12]).toBe(2);
    expect(moveTiles(tiles([...Array(12).fill(0), 2, 0, 0, 0]), 'up', fixed).cells[0]).toBe(2);
  });
  it('detects blocked boards and permits continued play after 2048', () => {
    expect(tilesOver([2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2])).toBe(true);
    expect(tilesOver([2, 2, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2])).toBe(false);
    const next = moveTiles(tiles([1024, 1024, ...Array(14).fill(0)]), 'left', fixed);
    expect(next.won).toBe(true);
    expect(next.over).toBe(false);
    expect(moveTiles(next, 'right', fixed).cells[3]).toBe(2048);
  });
});

describe('minesweeper', () => {
  it('keeps every possible first cell and its neighbors safe', () => {
    for (let i = 0; i < 81; i++) {
      const state = playMines(newMines(), i, false, fixed);
      expect(state.over).toBe(false);
      expect(state.cells.filter((c) => c.mine)).toHaveLength(10);
      for (const j of [i, ...neighbors(i)]) expect(state.cells[j].mine).toBe(false);
      expect(state.cells[i].open).toBe(true);
    }
  });
  it('protects flags from opening and reveals mines on defeat', () => {
    const flagged = playMines(newMines(), 0, true, fixed);
    expect(playMines(flagged, 0, false, fixed)).toBe(flagged);
    expect(flagged.ready).toBe(false);
    const state = playMines(newMines(), 40, false, fixed);
    const mine = state.cells.findIndex((c) => c.mine);
    const lost = playMines(state, mine, false, fixed);
    expect(lost.over).toBe(true);
    expect(lost.won).toBe(false);
    expect(lost.cells.filter((c) => c.mine).every((c) => c.open)).toBe(true);
    expect(playMines(lost, 0, true, fixed)).toBe(lost);
  });
  it('wins by opening safe cells without requiring flags', () => {
    let state = playMines(newMines(), 40, false, fixed);
    for (let i = 0; i < 81; i++)
      if (!state.cells[i].mine) state = playMines(state, i, false, fixed);
    expect(state.won).toBe(true);
    expect(state.over).toBe(true);
    expect(state.cells.filter((c) => c.flag)).toHaveLength(10);
  });
});
