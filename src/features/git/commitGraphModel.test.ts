import { describe, expect, it } from 'vitest';
import { graphStep, layoutGraph, maxGraphWidth, openLanes, rowPaths } from './commitGraphModel';

const commit = (hash: string, ...parents: string[]) => ({ hash, parents });
const shape = (rows: ReturnType<typeof layoutGraph>['rows']) =>
  rows.map((row) => ({
    column: row.column,
    into: row.into.map((l) => `${l.from}>${l.to}`),
    through: row.through.map((l) => `${l.from}>${l.to}`),
    out: row.out.map((l) => `${l.from}>${l.to}`),
  }));

describe('commit graph layout', () => {
  it('keeps a straight history in one column with one color', () => {
    const { rows, columns } = layoutGraph([commit('c', 'b'), commit('b', 'a'), commit('a')]);
    expect(columns).toBe(1);
    expect(shape(rows)).toEqual([
      { column: 0, into: [], through: [], out: ['0>0'] },
      { column: 0, into: ['0>0'], through: [], out: ['0>0'] },
      { column: 0, into: ['0>0'], through: [], out: [] },
    ]);
    expect(new Set(rows.map((row) => row.color)).size).toBe(1);
  });

  it('opens a lane for a merge parent and closes it where the branch started', () => {
    // m merges f2 into c3; the branch f1..f2 forked from b.
    const { rows, columns } = layoutGraph([
      commit('m', 'c3', 'f2'),
      commit('f2', 'f1'),
      commit('c3', 'b'),
      commit('f1', 'b'),
      commit('b'),
    ]);
    expect(columns).toBe(2);
    expect(rows[0]!.merge).toBe(true);
    expect(rows.slice(1).some((row) => row.merge)).toBe(false);
    expect(shape(rows)).toEqual([
      { column: 0, into: [], through: [], out: ['0>0', '0>1'] },
      { column: 1, into: ['1>1'], through: ['0>0'], out: ['1>1'] },
      { column: 0, into: ['0>0'], through: ['1>1'], out: ['0>0'] },
      { column: 1, into: ['1>1'], through: ['0>0'], out: ['1>1'] },
      // Both lanes wait for b, so they meet there.
      { column: 0, into: ['0>0', '1>0'], through: [], out: [] },
    ]);
    // The merged branch is told apart from main, and keeps its color down to the fork.
    expect(rows[0]!.out[1]!.color).not.toBe(rows[0]!.out[0]!.color);
    expect(rows[1]!.color).toBe(rows[0]!.out[1]!.color);
    expect(rows[3]!.color).toBe(rows[0]!.out[1]!.color);
  });

  it('gives a branch tip the next free column and joins it to its parent', () => {
    // The upstream has u1 on top of c, which main also reaches.
    const { rows, columns } = layoutGraph([commit('main', 'c'), commit('u1', 'c'), commit('c')]);
    expect(columns).toBe(2);
    expect(shape(rows)).toEqual([
      { column: 0, into: [], through: [], out: ['0>0'] },
      { column: 1, into: [], through: ['0>0'], out: ['1>1'] },
      { column: 0, into: ['0>0', '1>0'], through: [], out: [] },
    ]);
    expect(rows[1]!.color).not.toBe(rows[0]!.color);
  });

  it('shifts the lanes to the right of one that ended', () => {
    // x and y are unrelated histories after a root ends the first lane.
    const { rows } = layoutGraph([commit('a'), commit('b', 'c'), commit('c')]);
    expect(rows[0]!.out).toEqual([]);
    expect(rows[1]!.column).toBe(0);

    // A root in the middle: the lane to its right moves into its place.
    const { rows: middle } = layoutGraph([
      commit('t1', 'r'),
      commit('t2', 's'),
      commit('t3', 'q'),
      commit('s'),
      commit('q'),
      commit('r'),
    ]);
    expect(shape(middle)[3]).toEqual({
      column: 1,
      into: ['1>1'],
      through: ['0>0', '2>1'],
      out: [],
    });
    expect(middle[4]!.column).toBe(1);
  });

  it('draws an octopus merge with one lane per parent', () => {
    const { rows, columns } = layoutGraph([
      commit('m', 'a', 'b', 'c'),
      commit('a'),
      commit('b'),
      commit('c'),
    ]);
    expect(columns).toBe(3);
    expect(shape(rows)[0]).toEqual({
      column: 0,
      into: [],
      through: [],
      out: ['0>0', '0>1', '0>2'],
    });
    expect(new Set(rows[0]!.out.map((line) => line.color)).size).toBe(3);
  });

  it('leaves a lane open at the bottom when the parent is past the limit', () => {
    const { rows } = layoutGraph([commit('c', 'b'), commit('b', 'outside')]);
    expect(rows[1]!.out).toEqual([{ from: 0, to: 0, color: 0 }]);
    expect(openLanes(rows[1]!)).toEqual([{ column: 0, color: 0 }]);
  });

  it('reports what continues under a row, in column order', () => {
    const { rows } = layoutGraph([commit('m', 'a', 'b'), commit('a', 'x'), commit('b', 'x')]);
    expect(openLanes(rows[0]!).map((lane) => lane.column)).toEqual([0, 1]);
    expect(openLanes(rows[1]!).map((lane) => lane.column)).toEqual([0, 1]);
  });

  it('handles an empty list', () => {
    expect(layoutGraph([])).toEqual({ rows: [], columns: 0 });
  });
});

describe('commit graph drawing', () => {
  it('thins the lanes so the graph stays inside its width', () => {
    expect(graphStep(1)).toBe(12);
    expect(graphStep(8)).toBe(12);
    expect(graphStep(9)).toBe(10);
    for (const columns of [10, 16, 24]) {
      expect(graphStep(columns) * columns).toBeLessThanOrEqual(maxGraphWidth);
    }
    // Past that it stops shrinking: the lanes stay visible and the row clips.
    expect(graphStep(400)).toBe(4);
  });

  it('draws straight lanes as vertical lines and moved lanes as curves', () => {
    const { rows } = layoutGraph([commit('m', 'a', 'b'), commit('a', 'x'), commit('b', 'x')]);
    const paths = rowPaths(rows[0]!, 12, 22).map((path) => path.d);
    expect(paths).toEqual(['M6 11V22', 'M6 11C6 16.5 18 16.5 18 22']);
    const next = rowPaths(rows[1]!, 12, 22).map((path) => path.d);
    expect(next).toEqual(['M18 0V22', 'M6 0V11', 'M6 11V22']);
  });
});
