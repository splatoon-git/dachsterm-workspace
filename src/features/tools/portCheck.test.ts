import { describe, expect, it } from 'vitest';
import {
  applyCheckEvents,
  beginCheck,
  checkSummary,
  idleCheck,
  rowNote,
  rowText,
  type CheckEvent,
  type Outcome,
} from './portCheck';

const result = (host: string, port: number, outcome: Outcome = 'open'): CheckEvent => ({
  type: 'result',
  host,
  port,
  outcome,
  detail: null,
  method: 'direct',
});
const running = beginCheck(idleCheck, false);

describe('port check state', () => {
  it('orders results by host then port, numbers as numbers', () => {
    const state = applyCheckEvents(
      running,
      [result('10.0.0.10', 80), result('10.0.0.9', 443), result('10.0.0.9', 22)],
      1,
    );
    expect(state.rows.map((row) => `${row.host}:${row.port}`)).toEqual([
      '10.0.0.9:22',
      '10.0.0.9:443',
      '10.0.0.10:80',
    ]);
  });

  it('counts progress and says when the server has no more room', () => {
    let state = applyCheckEvents(
      running,
      [{ type: 'progress', done: 3, total: 10, waiting: false, phase: 'probing' }],
      1,
    );
    expect(checkSummary(state)).toBe('진행 3/10');
    state = applyCheckEvents(
      state,
      [{ type: 'progress', done: 4, total: 10, waiting: true, phase: 'probing' }],
      2,
    );
    expect(checkSummary(state)).toBe('진행 4/10 · 서버 응답 대기 중');
    state = applyCheckEvents(
      state,
      [{ type: 'progress', done: 10, total: 10, waiting: false, phase: 'confirming' }],
      3,
    );
    expect(checkSummary(state)).toBe('진행 10/10 · 닫힘 사유 확인 중');
  });

  it('summarises a finished check by how many opened', () => {
    const state = applyCheckEvents(
      running,
      [
        result('a', 1),
        result('a', 2, 'closed'),
        result('a', 3, 'noResponse'),
        { type: 'finished', cancelled: false, message: null },
      ],
      1,
    );
    expect(state.running).toBe(false);
    expect(checkSummary(state)).toBe('3개 중 1개 열림');
  });

  it('keeps what a cancelled check found', () => {
    const state = applyCheckEvents(
      running,
      [result('a', 1), { type: 'finished', cancelled: true, message: '정리함' }],
      1,
    );
    expect(state).toMatchObject({ cancelled: true, ended: '정리함', running: false });
    expect(state.rows).toHaveLength(1);
  });

  it('checking one row again replaces only that row and leaves the counts', () => {
    const first = applyCheckEvents(
      running,
      [
        result('a', 1, 'closed'),
        result('a', 2),
        { type: 'progress', done: 2, total: 2, waiting: false, phase: 'probing' },
        { type: 'finished', cancelled: false, message: null },
      ],
      1,
    );
    const again = beginCheck(first, true);
    expect(again.rows).toHaveLength(2);
    const after = applyCheckEvents(
      again,
      [
        { type: 'progress', done: 1, total: 1, waiting: false, phase: 'probing' },
        result('a', 1, 'open'),
        { type: 'finished', cancelled: false, message: null },
      ],
      2,
    );
    expect(after.rows.map((row) => row.outcome)).toEqual(['open', 'open']);
    expect(after.rows[0].at).toBe(2);
    expect(after.rows[1].at).toBe(1);
    expect(after.total).toBe(2);
  });

  it('a new check starts from nothing', () => {
    const done = applyCheckEvents(running, [result('a', 1)], 1);
    expect(beginCheck(done, false).rows).toEqual([]);
  });

  it('explains a result and how it was found', () => {
    const row = { ...(result('a', 1, 'closed') as CheckRowEvent), at: 0 };
    expect(rowNote(row)).toContain('프로그램이 없습니다');
    expect(rowNote({ ...row, method: 'nc', outcome: 'closedOrNoResponse' })).toContain('nc');
    expect(rowNote({ ...row, outcome: 'unknown', detail: '이유' })).toBe('이유');
  });

  it('copies one row as source, target, port, result, time', () => {
    const row = { ...(result('db', 5432, 'noResponse') as CheckRowEvent), at: 0 };
    const fields = rowText(row, 'WAS01').split('\t');
    expect(fields.slice(0, 4)).toEqual(['WAS01', 'db', '5432', '응답 없음']);
    expect(fields).toHaveLength(5);
  });
});

type CheckRowEvent = Extract<CheckEvent, { type: 'result' }>;
