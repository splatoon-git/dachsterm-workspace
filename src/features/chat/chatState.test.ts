import { describe, expect, it } from 'vitest';
import {
  applyChatEvent,
  waitsForUser,
  withAnswered,
  canSend,
  initialChat,
  withDisconnected,
  withLinkEnded,
  withReattached,
  withSent,
  type ChatState,
} from './chatState';
import { approvalScope, chatTranscript, commandMatches, modelLabel, tokenText } from './chatText';

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
      { kind: 'user', id: 1, text: '안녕', files: [] },
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
    expect(lost.phase).toBe('disconnected');
    expect(lost.items.at(-1)).toMatchObject({ tone: 'info' });
    expect(withDisconnected(lost)).toBe(lost);
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

  it('keeps what the agent offers, its context and its subagents', () => {
    let state = applyChatEvent(ready, {
      kind: 'capabilities',
      models: [
        { value: 'default', label: 'Default', detail: '', hint: 'claude-opus-5-5', levels: [] },
        { value: 'opus', label: 'Opus', detail: '', hint: 'claude-opus-5-5', levels: [] },
        {
          value: 'sonnet',
          label: 'Sonnet',
          detail: 'Sonnet 5.5',
          hint: 'claude-sonnet-5-5',
          levels: [],
        },
      ],
      commands: [
        { value: 'review', label: 'review', detail: '', hint: '[pr]', levels: [] },
        { value: 'compact', label: 'compact', detail: '', hint: '', levels: [] },
      ],
      agents: [],
      permissionMode: 'default',
      account: { plan: 'Claude Max', email: 'me@example.com' },
    });
    expect(commandMatches(state, '/re').map((c) => c.value)).toEqual(['review']);
    expect(commandMatches(state, '/re now')).toEqual([]);
    expect(modelLabel({ ...state, model: 'claude-opus-5-5' })).toBe('Opus');
    state = { ...state, chosen: 'sonnet' };
    expect(modelLabel(state)).toBe('Sonnet');
    state = applyChatEvent(state, {
      kind: 'context',
      model: 'claude-sonnet-5-5',
      percentage: 13,
      used: 25200,
      max: 200000,
      parts: [],
    });
    expect(state.context?.percentage).toBe(13);
    expect(state.model).toBe('claude-sonnet-5-5');
    state = applyChatEvent(state, {
      kind: 'agentStarted',
      id: 'a',
      call: 't1',
      role: 'Explore',
      task: 'look',
    });
    state = applyChatEvent(state, { kind: 'agentFinished', id: 'a', ok: true, summary: 'found' });
    expect(state.agents).toEqual([
      { id: 'a', call: 't1', role: 'Explore', task: 'look', status: 'done', summary: 'found' },
    ]);
    expect(tokenText(25200)).toBe('25k');
    expect(tokenText(9800)).toBe('9.8k');
  });

  it('a refused model change says why and drops the pick', () => {
    const state = applyChatEvent({ ...ready, chosen: 'x' }, { kind: 'problem', text: '안 됨' });
    expect(state.chosen).toBe('');
    expect(state.items.at(-1)).toMatchObject({ tone: 'error', text: '안 됨' });
  });

  it('copies the conversation as Markdown without tool output or thinking', () => {
    let state = withSent(ready, '고쳐 줘');
    state = applyChatEvent(state, { kind: 'thinking', done: false }, 0);
    state = applyChatEvent(state, {
      kind: 'toolStarted',
      id: 't',
      name: 'Read',
      summary: '/a.txt',
      edit: null,
    });
    state = applyChatEvent(state, { kind: 'toolFinished', id: 't', ok: true, output: 'secret' });
    state = applyChatEvent(state, { kind: 'text', text: '고쳤습니다.' });
    expect(chatTranscript(state)).toBe('**나:** 고쳐 줘\n\n- `Read` /a.txt\n\n고쳤습니다.');
  });

  it('keeps an approval until it is answered or its turn ends', () => {
    const asked = applyChatEvent(withSent(ready, 'x'), {
      kind: 'approvalAsked',
      request: 'r1',
      tool: 'Bash',
      summary: 'npm test',
      detail: '',
      edit: null,
      questions: [],
    });
    expect(waitsForUser(asked)).toBe(true);
    expect(waitsForUser(withAnswered(asked, 'r1', 'allowed'))).toBe(false);
    const ended = applyChatEvent(asked, { kind: 'turnFinished', ok: true, detail: null });
    expect(ended.items.at(-1)).toMatchObject({ kind: 'approval', status: 'expired' });
    expect(approvalScope('Edit', '/a')).toBe(approvalScope('Write', '/b'));
    expect(approvalScope('Bash', 'npm test')).not.toBe(approvalScope('Bash', 'rm -rf /'));
  });

  it('keeps a turn and its approval through a lost connection, to go on after reconnecting', () => {
    const asked = applyChatEvent(
      applyChatEvent(withSent(ready, 'x'), { kind: 'textDelta', text: '고치' }),
      {
        kind: 'approvalAsked',
        request: 'r1',
        tool: 'Edit',
        summary: '/a',
        detail: '',
        edit: null,
        questions: [],
      },
    );
    const lost = withDisconnected(asked);
    expect(lost.phase).toBe('disconnected');
    expect(canSend(lost)).toBe(false);
    // Nothing is settled: the card still waits and the reply is still being written.
    expect(waitsForUser(lost)).toBe(true);
    expect(lost.items.find((i) => i.kind === 'agent')).toMatchObject({ streaming: true });
    // A late end of the old reading changes nothing.
    expect(applyChatEvent(lost, { kind: 'ended', reason: 'disconnected', detail: null })).toBe(
      lost,
    );

    const back = withReattached(lost, false);
    expect(back.phase).toBe('working');
    expect(back.items.at(-1)).toMatchObject({ kind: 'notice', text: '다시 연결했습니다.' });
    const answered = withAnswered(back, 'r1', 'allowed');
    const finished = applyChatEvent(answered, { kind: 'turnFinished', ok: true, detail: null });
    expect(finished.phase).toBe('ready');
    expect(withReattached(finished, true)).toBe(finished);
  });

  it('comes back ready when nothing was running', () => {
    expect(withReattached(withDisconnected(ready), false).phase).toBe('ready');
    expect(withReattached(withDisconnected(ready), true).phase).toBe('working');
  });

  it('ends for good when the agent exits, connected or not', () => {
    const lost = withDisconnected(ready);
    const exited = applyChatEvent(lost, { kind: 'ended', reason: 'exited', detail: 'bye' });
    expect(exited.phase).toBe('ended');
    expect(withDisconnected(exited)).toBe(exited);
  });
});
