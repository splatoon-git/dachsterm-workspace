// @vitest-environment jsdom
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../../lib/ipc';
import { AgentSignQueue, currentSign, signPurpose, type PendingSign } from './agentSign';
import type { AgentSignRequest } from './sessionTypes';

vi.mock('../../lib/ipc', () => ({
  call: vi.fn(() => Promise.resolve()),
  errorText: (e: unknown) => String(e),
}));

const request = (id: string, extra: Partial<AgentSignRequest> = {}): AgentSignRequest => ({
  type: 'agentSign',
  request: id,
  session: 'prod',
  key: 'me@pc',
  fingerprint: 'SHA256:x',
  loginUser: null,
  namespace: null,
  hostKey: null,
  seconds: 60,
  ...extra,
});

describe('which request a pane shows', () => {
  const pending = (id: string, connectionId: string): PendingSign => ({
    ...request(id),
    connectionId,
  });
  it('shows the oldest request of the current connection only', () => {
    const items = [pending('old', 'gone'), pending('a', 'now'), pending('b', 'now')];
    expect(currentSign(items, 'now')?.request).toBe('a');
    expect(currentSign(items, 'other')).toBeNull();
  });
  it('says what is signed', () => {
    expect(signPurpose(request('r', { loginUser: 'git' }))).toContain('사용자 git');
    expect(signPurpose(request('r', { namespace: 'file' }))).toContain('용도 file');
    expect(signPurpose(request('r'))).toBe('용도를 알 수 없는 서명');
  });
});

describe('the queue', () => {
  const textarea = document.createElement('textarea');
  document.body.append(textarea);
  const notice = vi.fn();
  const queue = () =>
    new AgentSignQueue({
      terminal: { textarea } as unknown as Terminal,
      profile: { name: 'prod' },
      notice,
    });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(call).mockClear();
    notice.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a request when the backend stops waiting for it', () => {
    const q = queue();
    q.add(request('a', { seconds: 2 }), 'c1');
    expect(q.snapshot().map((i) => i.request)).toEqual(['a']);
    vi.advanceTimersByTime(1999);
    expect(q.snapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(q.snapshot()).toHaveLength(0);
  });

  it('answers on the connection the request came from and removes it at once', async () => {
    const q = queue();
    const changes = vi.fn();
    q.subscribe(changes);
    q.add(request('a'), 'c1');
    q.add(request('b'), 'c1');
    await q.answer(q.snapshot()[0], 'connection');
    expect(call).toHaveBeenCalledWith('agent_sign_reply', {
      id: 'c1',
      request: 'a',
      decision: 'connection',
    });
    expect(q.snapshot().map((i) => i.request)).toEqual(['b']);
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it('notifies through the program notification path when the user is elsewhere', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    // Past the app-wide notification interval that earlier cases in this file used up.
    vi.setSystemTime(Date.now() + 60_000);
    queue().add(request('a'), 'c1');
    expect(call).toHaveBeenCalledWith('notification_show', {
      title: 'prod — 입력 대기',
      body: '키 서명 승인 요청',
    });
  });

  it('stays quiet in the pane the user is looking at, and shows an answer that failed', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    textarea.focus();
    const q = queue();
    q.add(request('a'), 'c1');
    expect(call).not.toHaveBeenCalled();
    vi.mocked(call).mockRejectedValueOnce('서명 요청이 이미 끝났습니다.');
    await q.answer(q.snapshot()[0], 'once');
    expect(notice).toHaveBeenCalledWith('서명 요청이 이미 끝났습니다.');
  });
});
