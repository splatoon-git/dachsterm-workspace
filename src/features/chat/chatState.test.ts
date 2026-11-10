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
      { kind: 'agent', id: 2, text: '반가워요', streaming: false },
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

  it('streams a reply and lets the finished block replace it', () => {
    let state = withSent(ready, 'x');
    state = applyChatEvent(state, { kind: 'textDelta', text: '안' });
    state = applyChatEvent(state, { kind: 'textDelta', text: '녕' });
    expect(state.items.at(-1)).toMatchObject({ kind: 'agent', text: '안녕', streaming: true });
    state = applyChatEvent(state, { kind: 'text', text: '안녕하세요' });
    expect(state.items.at(-1)).toMatchObject({ text: '안녕하세요', streaming: false });
    expect(state.items.filter((i) => i.kind === 'agent')).toHaveLength(1);
  });

  it('times the thinking', () => {
    let state = applyChatEvent(ready, { kind: 'thinking', done: false }, 1000);
    state = applyChatEvent(state, { kind: 'thinking', done: true }, 7400);
    expect(state.items.at(-1)).toMatchObject({ kind: 'thinking', seconds: 6 });
  });

  it('follows a tool call to its result, and fails what a turn left running', () => {
    let state = applyChatEvent(ready, {
      kind: 'toolStarted',
      id: 't1',
      name: 'Bash',
      summary: 'npm test',
      edit: null,
    });
    state = applyChatEvent(state, { kind: 'toolFinished', id: 't1', ok: true, output: 'ok' });
    expect(state.items.at(-1)).toMatchObject({ status: 'done', output: 'ok' });
    state = applyChatEvent(state, {
      kind: 'toolStarted',
      id: 't2',
      name: 'Read',
      summary: '/a',
      edit: null,
    });
    state = applyChatEvent(state, { kind: 'turnFinished', ok: true, detail: null });
    expect(state.items.at(-1)).toMatchObject({ call: 't2', status: 'failed' });
  });

  it('a stopped turn is not an error', () => {
    const stopping = { ...withSent(ready, 'x'), stopping: true };
    const state = applyChatEvent(stopping, {
      kind: 'turnFinished',
      ok: false,
      detail: 'error_during_execution',
    });
    expect(state.items.at(-1)).toMatchObject({ tone: 'info', text: '중지했습니다.' });
    expect(state.stopping).toBe(false);
  });
});
