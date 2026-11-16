import { describe, expect, it } from 'vitest';
import {
  checkedText,
  isBusy,
  pendingVersion,
  progressPercent,
  progressText,
  separateError,
  type UpdatePhase,
} from './updateState';

describe('update state', () => {
  it('points out a version only while one waits or installs', () => {
    const phases: [UpdatePhase, string | null][] = [
      [{ state: 'idle' }, null],
      [{ state: 'checking' }, null],
      [{ state: 'latest', checked: 0 }, null],
      [{ state: 'failed', message: 'x' }, null],
      [{ state: 'available', version: '0.6.0', notes: null, date: null }, '0.6.0'],
      [{ state: 'downloading', version: '0.6.0', received: 1, total: 2 }, '0.6.0'],
      [{ state: 'installing', version: '0.6.0' }, '0.6.0'],
    ];
    for (const [phase, version] of phases) expect(pendingVersion(phase)).toBe(version);
  });

  it('blocks another check only while one runs', () => {
    expect(isBusy({ state: 'checking' })).toBe(true);
    expect(isBusy({ state: 'installing', version: '1' })).toBe(true);
    expect(isBusy({ state: 'available', version: '1', notes: null, date: null })).toBe(false);
    expect(isBusy({ state: 'failed', message: '' })).toBe(false);
  });

  it('shows download progress with and without a known size', () => {
    const mb = 1024 * 1024;
    const known = { state: 'downloading', version: '1', received: 3 * mb, total: 12 * mb } as const;
    expect(progressText(known)).toBe('3.0 / 12.0 MB');
    expect(progressPercent(known)).toBe(25);
    const unknown = { ...known, total: null };
    expect(progressText(unknown)).toBe('3.0 MB 받음');
    expect(progressPercent(unknown)).toBeNull();
    expect(progressPercent({ ...known, received: 13 * mb })).toBe(100);
  });

  it('shows a failed install once, not again as the request error', () => {
    const message = '서명이 맞지 않습니다.';
    expect(separateError({ state: 'failed', message }, message)).toBe('');
    expect(separateError({ state: 'failed', message }, '다른 오류')).toBe('다른 오류');
    expect(separateError({ state: 'idle' }, message)).toBe(message);
    expect(separateError({ state: 'idle' }, '')).toBe('');
  });

  it('says today for a check made today', () => {
    const now = new Date(2026, 10, 16, 15, 0);
    const today = new Date(2026, 10, 16, 9, 5).getTime() / 1000;
    const earlier = new Date(2026, 10, 14, 9, 5).getTime() / 1000;
    expect(checkedText(today, now)).toMatch(/^오늘 /);
    expect(checkedText(earlier, now)).not.toMatch(/^오늘 /);
  });
});
