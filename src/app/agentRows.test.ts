import { describe, expect, it } from 'vitest';
import {
  boardCounts,
  elapsedText,
  nextBlocked,
  parseAgentStatus,
  sortRows,
  type AgentRow,
} from './agentRows';

const row = (key: string, state: AgentRow['state'], since = 1000): AgentRow => ({
  key,
  name: key,
  state,
  since,
  git: '',
  detail: '',
});

describe('agent board', () => {
  it('puts waiting tabs first, then errors, running and finished work, older first', () => {
    const rows = sortRows([
      row('done', 'done', 1),
      row('working', 'working', 1),
      row('new-wait', 'blocked', 300),
      row('error', 'error', 1),
      row('old-wait', 'blocked', 200),
    ]);
    expect(rows.map((r) => r.key)).toEqual(['old-wait', 'new-wait', 'error', 'working', 'done']);
  });

  it('counts only the states some tab reports', () => {
    const counts = boardCounts([row('a', 'blocked'), row('b', 'working'), row('c', 'blocked')]);
    expect(counts.map((c) => c.text).join(' · ')).toBe('입력 대기 2 · 작업 중 1');
    expect(boardCounts([])).toEqual([]);
  });

  it('writes the time in a state in minutes and hours', () => {
    expect(elapsedText(59_000)).toBe('1분 미만');
    expect(elapsedText(-5)).toBe('1분 미만');
    expect(elapsedText(5 * 60_000 + 1)).toBe('5분');
    expect(elapsedText(120 * 60_000)).toBe('2시간');
    expect(elapsedText(125 * 60_000)).toBe('2시간 5분');
  });

  it('moves through the waiting tabs in list order and wraps around', () => {
    const rows = sortRows([row('a', 'blocked', 1), row('w', 'working', 1), row('b', 'blocked', 2)]);
    expect(nextBlocked(rows)?.key).toBe('a');
    expect(nextBlocked(rows, 'w')?.key).toBe('a');
    expect(nextBlocked(rows, 'a')?.key).toBe('b');
    expect(nextBlocked(rows, 'b')?.key).toBe('a');
    expect(nextBlocked([row('w', 'working')], 'w')).toBeNull();
  });

  it('accepts only a well-formed report from an independent window', () => {
    const report = {
      name: '서버',
      state: 'blocked',
      since: 5,
      git: 'main ●1',
      detail: '입력 대기',
    };
    expect(parseAgentStatus({ window: 'terminal-abc-1', report })).toEqual({
      window: 'terminal-abc-1',
      report,
    });
    expect(parseAgentStatus({ window: 'terminal-abc-1', report: null })).toEqual({
      window: 'terminal-abc-1',
      report: null,
    });
    for (const payload of [
      null,
      'text',
      { window: 'main', report },
      { window: 'terminal-a/b', report },
      { window: 'terminal-a', report: { ...report, state: 'idle' } },
      { window: 'terminal-a', report: { ...report, state: 'pwned' } },
      { window: 'terminal-a', report: { ...report, since: Number.NaN } },
      { window: 'terminal-a', report: { ...report, name: 3 } },
      { window: 'terminal-a', report: { ...report, git: undefined } },
      { window: 'terminal-a' },
    ])
      expect(parseAgentStatus(payload)).toBeNull();
    const long = parseAgentStatus({
      window: 'terminal-a',
      report: { ...report, detail: 'x'.repeat(900) },
    });
    expect(long?.report?.detail).toHaveLength(400);
  });
});
