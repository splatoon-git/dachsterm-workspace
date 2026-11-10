import { Channel } from '@tauri-apps/api/core';
import type { AuthPrompt, HostKeyRequest } from '../components/ConnectionCards';
import { call, errorText, type Profile } from './ipc';

export type LinkEvent =
  HostKeyRequest | AuthPrompt | { type: 'state'; status: string; message: string };
export type LinkState = {
  /** Sent to the backend as the connection. Null while nothing is open. */
  id: string | null;
  profile: Profile | null;
  /** `none`, `trust`, or the backend's own status text. */
  status: string;
  message: string;
  hostKey: HostKeyRequest | null;
  authPrompt: AuthPrompt | null;
};

export const noLink: LinkState = {
  id: null,
  profile: null,
  status: 'none',
  message: '',
  hostKey: null,
  authPrompt: null,
};

export function applyLinkEvent(state: LinkState, event: LinkEvent): LinkState {
  if (event.type === 'hostKey')
    return {
      ...state,
      status: 'trust',
      message: '최초 호스트키 확인이 필요합니다.',
      hostKey: event,
      // The question before this one has been answered, or the server would not have got here.
      authPrompt: null,
    };
  if (event.type === 'authPrompt')
    return { ...state, authPrompt: event, message: '서버의 인증 응답을 입력하세요.' };
  return {
    ...state,
    status: event.status,
    message: event.message,
    hostKey: null,
    authPrompt: null,
  };
}

/** The backend commands behind a link (one logs in, one lets go) and the words while it logs in. */
export type LinkCommands = { connect: string; disconnect: string; connecting: string };

/**
 * An SSH connection that stops after login, owned by one tab: a network tool's source (TL.5) or an
 * agent chat (AC.1). Letting go closes what it opened.
 */
export class LoginLink {
  protected state = noLink;
  private listeners = new Set<() => void>();
  constructor(protected readonly commands: LinkCommands) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  protected set(next: LinkState) {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
  async open(profile: Profile) {
    this.release();
    const id = crypto.randomUUID();
    const channel = new Channel<LinkEvent>();
    channel.onmessage = (event) => {
      if (this.state.id === id) this.set(applyLinkEvent(this.state, event));
    };
    this.set({ ...noLink, id, profile, status: 'connecting', message: this.commands.connecting });
    try {
      await call(this.commands.connect, { id, profileId: profile.id, onEvent: channel });
    } catch (e) {
      this.report(id, e);
      return;
    }
    // The tab was closed or the choice changed while the backend was starting.
    if (this.state.id !== id) this.close(id);
  }
  protected report(id: string, error: unknown) {
    if (this.state.id === id)
      this.set({
        ...this.state,
        status: 'error',
        message: errorText(error),
        hostKey: null,
        authPrompt: null,
      });
  }
  private close(id: string) {
    // The link is already gone from the screen; a backend that has also lost it has nothing to do.
    void call(this.commands.disconnect, { id }).catch(() => {});
  }
  release() {
    const { id } = this.state;
    if (!id) return;
    this.set(noLink);
    this.close(id);
  }
  async trust(accept: boolean) {
    const { id, hostKey } = this.state;
    if (!id || !hostKey) return;
    try {
      await call('trust_host', { id, accept, challenge: hostKey.challenge });
      if (this.state.hostKey?.challenge === hostKey.challenge)
        this.set({
          ...this.state,
          hostKey: null,
          message: accept ? '호스트키를 저장하고 있습니다.' : '연결을 취소하고 있습니다.',
        });
    } catch (e) {
      this.report(id, e);
    }
  }
  reply(responses: string[]) {
    const { id, authPrompt } = this.state;
    return call('auth_reply', { id, challenge: authPrompt?.challenge, responses });
  }
}
