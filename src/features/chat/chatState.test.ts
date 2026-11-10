import { describe, expect, it } from 'vitest';
import {
  applyChatEvent,
  canSend,
  initialChat,
  withLinkEnded,
  withSent,
  type ChatState,
} from './chatState';

const ready: ChatState = { ...initialChat, phase: 'ready' };

describe('chat state', () => {
  it('runs a turn from the user message to the agent reply', () => {
    let state = withSent(ready, '안녕');
    expect(state.phase).toBe('working');
    state = applyChatEvent(state, { kind: 'started', session: 's', model: 'm' });
    state = applyChatEvent(state, { kind: 'text', text: '반가워요' });
    state = applyChatEvent(state, { kind: 'turnFinished', ok: true, detail: null });
    expect(state.phase).toBe('ready');
    expect(state.model).toBe('m');
    expect(state.items).toEqual([
      { kind: 'user', id: 1, text: '안녕' },
      { kind: 'agent', id: 2, text: '반가워요' },
    ]);
  });

  it('says why a turn failed', () => {
    const state = applyChatEvent(withSent(ready, 'x'), {
      kind: 'turnFinished',
      ok: false,
      detail: 'error_during_execution',
    });
    expect(state.phase).toBe('ready');
    expect(state.items.at(-1)).toMatchObject({
      kind: 'notice',
      tone: 'error',
      text: '작업이 실패했습니다. error_during_execution',
    });
  });

  it('accepts messages during a turn and none after the end', () => {
    expect(canSend(withSent(ready, 'x'))).toBe(true);
    expect(canSend(initialChat)).toBe(false);
    const ended = applyChatEvent(ready, {
      kind: 'ended',
      reason: 'exited',
      detail: 'not logged in',
    });
    expect(canSend(ended)).toBe(false);
    expect(ended.items.at(-1)).toMatchObject({ text: '에이전트가 종료되었습니다.\nnot logged in' });
  });

  it('tells a broken connection from an exited agent, once', () => {
    const lost = applyChatEvent(ready, { kind: 'ended', reason: 'disconnected', detail: null });
    expect(lost.items.at(-1)).toMatchObject({ tone: 'info' });
    expect(withLinkEnded(lost, '서버 연결이 끊어졌습니다.')).toBe(lost);
    expect(withLinkEnded(ready, '서버 연결이 끊어졌습니다.').phase).toBe('ended');
  });

  it('keeps the end when a late turn result arrives', () => {
    const ended = withLinkEnded(withSent(ready, 'x'), '끊김');
    expect(applyChatEvent(ended, { kind: 'turnFinished', ok: true, detail: null }).phase).toBe(
      'ended',
    );
  });
});
