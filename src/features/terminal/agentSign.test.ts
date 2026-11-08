// @vitest-environment jsdom
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../../lib/ipc';
import {
  AgentSignQueue,
  credentialProblem,
  currentSign,
  signPurpose,
  signSource,
  signWaiting,
  type PendingApproval,
  type PendingCredential,
  type PendingSign,
} from './agentSign';
import type { AgentSignRequest, GitCredentialRequest } from './sessionTypes';

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
  source: 'system',
  passphrase: false,
  seconds: 60,
  ...extra,
});

const credential = (id: string, seconds = 60): GitCredentialRequest => ({
  type: 'gitCredential',
  request: id,
  session: 'prod',
  host: 'git.example:443',
  path: null,
  username: null,
  serverHelpers: [],
  seconds,
});
const sign = (item: PendingApproval) => item as PendingSign;
const asked = (item: PendingApproval) => item as PendingCredential;

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
  it('waits like a program, naming what it waits for', () => {
    const items = [{ ...credential('g'), connectionId: 'now' }];
    expect(signWaiting(items, 'now')).toEqual({
      state: 'blocked',
      detail: 'Git 자격 증명 승인 요청',
    });
    expect(signWaiting([pending('a', 'now')], 'now')?.detail).toBe('키 서명 승인 요청');
    expect(signWaiting(items, 'other')).toBeNull();
  });
  it('says what is signed', () => {
    expect(signPurpose(request('r', { loginUser: 'git' }))).toContain('사용자 git');
    expect(signPurpose(request('r', { namespace: 'file' }))).toContain('용도 file');
    expect(signPurpose(request('r'))).toBe('용도를 알 수 없는 서명');
  });
  it('says whose key signs', () => {
    expect(signSource(request('r', { source: 'app' }))).toBe('이 앱의 키 파일');
    expect(signSource(request('r'))).toBe('이 PC의 SSH agent');
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
    await q.answer(sign(q.snapshot()[0]), { decision: 'connection' });
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
    await q.answer(sign(q.snapshot()[0]), { decision: 'once' });
    expect(notice).toHaveBeenCalledWith('서명 요청이 이미 끝났습니다.');
  });

  it('keeps a locked key request until its Passphrase is accepted', async () => {
    const q = queue();
    q.add(request('a', { source: 'app', passphrase: true, seconds: 120 }), 'c1');
    vi.mocked(call).mockResolvedValueOnce({ kind: 'passphrase', reason: 'needed' });
    const asked = await q.answer(sign(q.snapshot()[0]), { decision: 'once' });
    expect(asked).toEqual({ kind: 'passphrase', reason: 'needed' });
    expect(q.snapshot()).toHaveLength(1);
    vi.mocked(call).mockResolvedValueOnce({ kind: 'done', notice: '저장 실패' });
    await q.answer(sign(q.snapshot()[0]), { decision: 'once', passphrase: 'p', remember: true });
    expect(call).toHaveBeenLastCalledWith('agent_sign_reply', {
      id: 'c1',
      request: 'a',
      decision: 'once',
      passphrase: 'p',
      remember: true,
    });
    expect(q.snapshot()).toHaveLength(0);
    expect(notice).toHaveBeenCalledWith('저장 실패');
  });

  it('keeps a credential request while the value is looked up, and gives typing more time', async () => {
    const q = queue();
    q.add(credential('g', 60), 'c1');
    vi.mocked(call).mockResolvedValueOnce({ kind: 'input', reason: 'notFound', seconds: 120 });
    const reply = await q.answerCredential(asked(q.snapshot()[0]), { decision: 'once' });
    expect(reply).toEqual({ kind: 'input', reason: 'notFound', seconds: 120 });
    expect(call).toHaveBeenLastCalledWith('git_credential_reply', {
      id: 'c1',
      request: 'g',
      decision: 'once',
    });
    vi.advanceTimersByTime(100_000);
    // The first 60 seconds were replaced.
    expect(q.snapshot()).toHaveLength(1);
    vi.mocked(call).mockResolvedValueOnce({ kind: 'done', notice: null });
    await q.answerCredential(asked(q.snapshot()[0]), {
      decision: 'once',
      username: 'me',
      password: 't',
      remember: false,
    });
    expect(q.snapshot()).toHaveLength(0);
    q.add(credential('h', 60), 'c1');
    vi.advanceTimersByTime(60_000);
    // Silence ends it.
    expect(q.snapshot()).toHaveLength(0);
  });

  it('removes a refused credential request at once and reports a failed answer', async () => {
    const q = queue();
    q.add(credential('g'), 'c1');
    let resolve!: (value: unknown) => void;
    vi.mocked(call).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const answered = q.answerCredential(asked(q.snapshot()[0]), { decision: 'deny' });
    expect(q.snapshot()).toHaveLength(0);
    resolve({ kind: 'done', notice: null });
    await answered;
    q.add(credential('h'), 'c1');
    vi.mocked(call).mockRejectedValueOnce('자격 증명 요청이 이미 끝났습니다.');
    expect(await q.answerCredential(asked(q.snapshot()[0]), { decision: 'connection' })).toBe(null);
    expect(q.snapshot()).toHaveLength(0);
    expect(notice).toHaveBeenCalledWith('자격 증명 요청이 이미 끝났습니다.');
  });
});

describe('a typed credential', () => {
  it('is one line each, within the backend limits', () => {
    expect(credentialProblem('me', 'token')).toBeNull();
    expect(credentialProblem('', 'token')).not.toBeNull();
    expect(credentialProblem('me', '')).not.toBeNull();
    expect(credentialProblem('me', 'a\nhost=evil')).toContain('한 줄');
    expect(credentialProblem('me\u0085', 't')).toContain('한 줄');
    expect(credentialProblem('가'.repeat(86), 't')).not.toBeNull();
    expect(credentialProblem('me', 't'.repeat(16385))).not.toBeNull();
  });
});
