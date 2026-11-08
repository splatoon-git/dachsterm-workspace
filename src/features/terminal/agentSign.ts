import type { Terminal } from '@xterm/xterm';
import { useSyncExternalStore } from 'react';
import type { ProgramSummary } from './programStatus';
import { call, errorText } from '../../lib/ipc';
import type { AgentSignRequest, GitCredentialRequest } from './sessionTypes';
import { programNotifier } from './terminalNotify';

export type SignDecision = 'deny' | 'once' | 'connection';
export type PendingSign = AgentSignRequest & { connectionId: string };
export type PendingCredential = GitCredentialRequest & { connectionId: string };
/** Every request a pane answers on its card: a key signature or an HTTPS Git credential. */
export type PendingApproval = PendingSign | PendingCredential;
export type SignAnswer = { decision: SignDecision; passphrase?: string; remember?: boolean };
/** `agent_sign_reply`: done, or the card has to ask for the key's Passphrase. */
export type SignReply =
  | { kind: 'done'; notice: string | null }
  | { kind: 'passphrase'; reason: 'needed' | 'wrong' | 'stored' };
export type CredentialAnswer = {
  decision: SignDecision | 'input';
  username?: string;
  password?: string;
  remember?: boolean;
};
/** `git_credential_reply`: done, or the card asks the user to type the value, with new time. */
export type CredentialReply =
  | { kind: 'done'; notice: string | null }
  | { kind: 'input'; reason: 'chosen' | 'notFound'; seconds: number };

type Host = {
  readonly terminal: Terminal;
  readonly profile: { name: string };
  notice: (message: string) => void;
};

const waitingDetail = (item: { type: PendingApproval['type'] }) =>
  item.type === 'gitCredential' ? 'Git 자격 증명 승인 요청' : '키 서명 승인 요청';

/**
 * Requests waiting for the user, oldest first. The backend refuses a request by itself after
 * `seconds`, so it also leaves this list then. A request belongs to the connection it came on: a
 * reconnect gets a new ID and an old request can no longer be answered.
 */
export class AgentSignQueue {
  private items: readonly PendingApproval[] = [];
  private listeners = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private notify?: ReturnType<typeof programNotifier>;
  constructor(private readonly host: Host) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.items;
  private set(items: readonly PendingApproval[]) {
    this.items = items;
    this.listeners.forEach((listener) => listener());
  }
  add(request: AgentSignRequest | GitCredentialRequest, connectionId: string) {
    this.set([...this.items, { ...request, connectionId }]);
    this.expire(request.request, request.seconds);
    // The AT.3 path: a notification only when the user is not looking at this terminal.
    this.notify ??= programNotifier({
      terminal: this.host.terminal,
      sessionName: () => this.host.profile.name,
      replaying: () => false,
      notice: (message) => this.host.notice(message),
    });
    this.notify('blocked', waitingDetail(request));
  }
  /** The backend may give a request more time, for typing a value on its card. */
  private expire(request: string, seconds: number) {
    clearTimeout(this.timers.get(request));
    this.timers.set(
      request,
      setTimeout(() => this.drop(request), seconds * 1000),
    );
  }
  private drop(request: string) {
    clearTimeout(this.timers.get(request));
    this.timers.delete(request);
    if (this.items.some((item) => item.request === request))
      this.set(this.items.filter((item) => item.request !== request));
  }
  /**
   * A plain answer leaves the list at once, so a second press cannot answer twice. A request for
   * a locked key stays until the backend has its Passphrase.
   */
  async answer(item: PendingSign, answer: SignAnswer): Promise<SignReply | null> {
    const waits = item.passphrase && answer.decision !== 'deny';
    if (!waits) this.drop(item.request);
    try {
      const reply = await call<SignReply | undefined>('agent_sign_reply', {
        id: item.connectionId,
        request: item.request,
        ...answer,
      });
      if (reply?.kind === 'passphrase') return reply;
      this.drop(item.request);
      if (reply?.notice) this.host.notice(reply.notice);
      return reply ?? null;
    } catch (error) {
      this.drop(item.request);
      this.host.notice(errorText(error));
      return null;
    }
  }
  /**
   * Only a refusal leaves the list before the backend answers. An allow may open this PC's
   * sign-in window or turn the card into fields, so the request stays until it is done.
   */
  async answerCredential(
    item: PendingCredential,
    answer: CredentialAnswer,
  ): Promise<CredentialReply | null> {
    if (answer.decision === 'deny') this.drop(item.request);
    try {
      const reply = await call<CredentialReply | undefined>('git_credential_reply', {
        id: item.connectionId,
        request: item.request,
        ...answer,
      });
      if (reply?.kind === 'input') {
        this.expire(item.request, reply.seconds);
        return reply;
      }
      this.drop(item.request);
      if (reply?.notice) this.host.notice(reply.notice);
      return reply ?? null;
    } catch (error) {
      this.drop(item.request);
      this.host.notice(errorText(error));
      return null;
    }
  }
}

/** The card checks a typed value as the backend does: one line each, within the same limits. */
export function credentialProblem(username: string, password: string) {
  // eslint-disable-next-line no-control-regex
  const control = /[\u0000-\u001f\u007f-\u009f]/;
  if (!username || !password) return '사용자 이름과 토큰을 입력하세요.';
  if (control.test(username) || control.test(password))
    return '사용자 이름과 토큰을 한 줄로 입력하세요.';
  if (new TextEncoder().encode(username).length > 256) return '사용자 이름이 너무 깁니다.';
  if (new TextEncoder().encode(password).length > 16384) return '토큰이 너무 깁니다.';
  return null;
}

/** The request a pane shows: the oldest one on its current connection. */
export function currentSign(items: readonly PendingApproval[], connectionId: string) {
  return items.find((item) => item.connectionId === connectionId) ?? null;
}

/** A waiting request reads like a program waiting for input, on the tab and in the agent list. */
export function signWaiting(
  items: readonly PendingApproval[],
  connectionId: string,
): ProgramSummary | null {
  const item = currentSign(items, connectionId);
  return item ? { state: 'blocked', detail: waitingDetail(item) } : null;
}

export function useSignWaiting(queue: AgentSignQueue, connectionId: string) {
  const items = useSyncExternalStore(queue.subscribe, queue.snapshot);
  return signWaiting(items, connectionId);
}

export const signSource = (request: AgentSignRequest) =>
  request.source === 'app' ? '이 앱의 키 파일' : '이 PC의 SSH agent';

export const passphraseReason = {
  needed: '암호화된 키 파일입니다. Passphrase를 입력하세요.',
  wrong: 'Passphrase가 맞지 않습니다. 다시 입력하세요.',
  stored: '저장된 Passphrase를 읽지 못했습니다(암호 보관함 잠김 등). 직접 입력하세요.',
} as const;

export function signPurpose(request: AgentSignRequest) {
  if (request.loginUser !== null) return `다른 SSH 서버 로그인 · 사용자 ${request.loginUser}`;
  if (request.namespace !== null) return `데이터 서명 · 용도 ${request.namespace}`;
  return '용도를 알 수 없는 서명';
}
