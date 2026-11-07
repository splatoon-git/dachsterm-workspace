import type { Terminal } from '@xterm/xterm';
import { useSyncExternalStore } from 'react';
import type { ProgramSummary } from './programStatus';
import { call, errorText } from '../../lib/ipc';
import type { AgentSignRequest } from './sessionTypes';
import { programNotifier } from './terminalNotify';

export type SignDecision = 'deny' | 'once' | 'connection';
export type PendingSign = AgentSignRequest & { connectionId: string };

type Host = {
  readonly terminal: Terminal;
  readonly profile: { name: string };
  notice: (message: string) => void;
};

/**
 * Sign requests waiting for the user, oldest first. The backend refuses a request by itself after
 * `seconds`, so it also leaves this list then. A request belongs to the connection it came on: a
 * reconnect gets a new ID and an old request can no longer be answered.
 */
export class AgentSignQueue {
  private items: readonly PendingSign[] = [];
  private listeners = new Set<() => void>();
  private notify?: ReturnType<typeof programNotifier>;
  constructor(private readonly host: Host) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.items;
  private set(items: readonly PendingSign[]) {
    this.items = items;
    this.listeners.forEach((listener) => listener());
  }
  add(request: AgentSignRequest, connectionId: string) {
    this.set([...this.items, { ...request, connectionId }]);
    setTimeout(() => this.drop(request.request), request.seconds * 1000);
    // The AT.3 path: a notification only when the user is not looking at this terminal.
    this.notify ??= programNotifier({
      terminal: this.host.terminal,
      sessionName: () => this.host.profile.name,
      replaying: () => false,
      notice: (message) => this.host.notice(message),
    });
    this.notify('blocked', '키 서명 승인 요청');
  }
  private drop(request: string) {
    if (this.items.some((item) => item.request === request))
      this.set(this.items.filter((item) => item.request !== request));
  }
  async answer(item: PendingSign, decision: SignDecision) {
    this.drop(item.request);
    try {
      await call('agent_sign_reply', { id: item.connectionId, request: item.request, decision });
    } catch (error) {
      this.host.notice(errorText(error));
    }
  }
}

/** The request a pane shows: the oldest one on its current connection. */
export function currentSign(items: readonly PendingSign[], connectionId: string) {
  return items.find((item) => item.connectionId === connectionId) ?? null;
}

const waiting: ProgramSummary = { state: 'blocked', detail: '키 서명 승인 요청' };

/** The tab shows a waiting request like a program waiting for input. */
export function useSignWaiting(queue: AgentSignQueue, connectionId: string) {
  const items = useSyncExternalStore(queue.subscribe, queue.snapshot);
  return currentSign(items, connectionId) ? waiting : null;
}

export function signPurpose(request: AgentSignRequest) {
  if (request.loginUser !== null) return `다른 SSH 서버 로그인 · 사용자 ${request.loginUser}`;
  if (request.namespace !== null) return `데이터 서명 · 용도 ${request.namespace}`;
  return '용도를 알 수 없는 서명';
}
