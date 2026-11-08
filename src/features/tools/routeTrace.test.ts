import { describe, expect, it } from 'vitest';
import {
  applyTraceEvent,
  beginTrace,
  conclusionText,
  hopDevice,
  hopNote,
  hopTime,
  idleTrace,
  methodNote,
  type TraceHop,
} from './routeTrace';

const hop = (number: number, over: Partial<TraceHop> = {}): TraceHop => ({
  hop: number,
  address: `10.0.0.${number}`,
  rttMs: 1.5,
  reached: false,
  unreachable: false,
  ...over,
});

describe('applyTraceEvent', () => {
  it('keeps hops in order and replaces a repeated hop', () => {
    let state = beginTrace();
    state = applyTraceEvent(state, { type: 'method', method: 'tcpPort' });
    state = applyTraceEvent(state, { type: 'hop', hop: hop(2) });
    state = applyTraceEvent(state, { type: 'hop', hop: hop(1, { address: null }) });
    state = applyTraceEvent(state, { type: 'hop', hop: hop(1) });
    expect(state.method).toBe('tcpPort');
    expect(state.hops.map((item) => [item.hop, item.address])).toEqual([
      [1, '10.0.0.1'],
      [2, '10.0.0.2'],
    ]);
    expect(state.running).toBe(true);
  });
  it('ends with its conclusion and note', () => {
    const state = applyTraceEvent(beginTrace(), {
      type: 'finished',
      cancelled: false,
      conclusion: { kind: 'noReply' },
      note: 'cut off',
    });
    expect(state).toEqual({
      ...idleTrace,
      conclusion: { kind: 'noReply' },
      note: 'cut off',
    });
  });
  it('remembers a cancel', () => {
    const state = applyTraceEvent(beginTrace(), {
      type: 'finished',
      cancelled: true,
      conclusion: null,
      note: null,
    });
    expect(state.cancelled).toBe(true);
    expect(state.running).toBe(false);
  });
});

describe('conclusionText', () => {
  it('stops at where replies ended and accuses nothing', () => {
    const text = conclusionText({ kind: 'lastResponder', address: '10.0.1.1' });
    expect(text).toBe('마지막 응답 장비는 10.0.1.1, 그 다음 구간에서 끊김');
    expect(text).not.toMatch(/차단|방화벽|막았/);
  });
  it('covers every other ending', () => {
    expect(conclusionText({ kind: 'reached' })).toBe('대상까지 도달했습니다.');
    expect(conclusionText({ kind: 'noReply' })).toBe('응답한 장비가 없습니다.');
    expect(conclusionText({ kind: 'unavailable' })).toBe(
      '이 서버에서는 경로 추적을 할 수 없습니다',
    );
    expect(conclusionText({ kind: 'failed', message: '이유' })).toBe('이유');
  });
});

describe('labels', () => {
  it('says which probes are not about the checked port', () => {
    expect(methodNote.icmp).toContain('참고용 ICMP');
    expect(methodNote.icmp).toContain('무관');
    expect(methodNote.udp).toContain('무관');
    expect(methodNote.tracepath).toContain('무관');
    expect(methodNote.tcpPort).not.toContain('무관');
  });
  it('words each hop', () => {
    expect(hopDevice(hop(1, { address: null }))).toBe('응답 없음');
    expect(hopDevice(hop(1))).toBe('10.0.0.1');
    expect(hopTime(hop(1, { rttMs: null }))).toBe('');
    expect(hopTime(hop(1))).toBe('1.5ms');
    expect(hopNote(hop(1, { reached: true }))).toBe('대상');
    expect(hopNote(hop(1, { unreachable: true }))).toContain('경로');
    expect(hopNote(hop(1))).toBe('');
  });
});
