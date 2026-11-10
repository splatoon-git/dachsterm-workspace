import { describe, expect, it } from 'vitest';
import {
  applyChatEvent,
  initialChat,
  withDisconnected,
  withSent,
  type ChatState,
} from './chatState';
import { chatSummary } from './chatStatus';

const ready: ChatState = { ...initialChat, phase: 'ready' };
const ask = (state: ChatState, request: string, question = '') =>
  applyChatEvent(state, {
    kind: 'approvalAsked',
    request,
    tool: question ? 'AskUserQuestion' : 'Bash',
    summary: 'npm test',
    detail: '',
    edit: null,
    questions: question ? [{ question, header: '', multi: false, options: [] }] : [],
  });

describe('chat status for the tab and the agent list', () => {
  it('reports nothing while idle or after the end', () => {
    expect(chatSummary(ready)).toBeNull();
    expect(chatSummary(initialChat)).toBeNull();
    expect(chatSummary({ ...ask(withSent(ready, 'x'), 'r1'), phase: 'ended' })).toBeNull();
  });

  it('reports a running turn as working', () => {
    expect(chatSummary(withSent(ready, 'x'))).toEqual({ state: 'working', detail: '' });
  });

  it('reports an approval or a question as waiting for input, the first asked first', () => {
    const asked = ask(withSent(ready, 'x'), 'r1');
    expect(chatSummary(asked)).toEqual({
      state: 'blocked',
      kind: 'permission',
      detail: 'Bash npm test',
    });
    expect(chatSummary(ask(asked, 'r2', '어느 색?'))).toMatchObject({ kind: 'permission' });
    expect(chatSummary(ask(withSent(ready, 'x'), 'r2', '어느 색?'))).toEqual({
      state: 'blocked',
      kind: 'question',
      detail: '어느 색?',
    });
  });

  it('keeps waiting while disconnected, and says how to answer', () => {
    const lost = withDisconnected(ask(withSent(ready, 'x'), 'r1'));
    expect(chatSummary(lost)).toMatchObject({ state: 'blocked' });
    expect(chatSummary(lost)?.detail).toContain('다시 연결');
    expect(chatSummary(withDisconnected(ready))).toBeNull();
  });
});
