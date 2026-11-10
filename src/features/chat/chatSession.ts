import { Channel } from '@tauri-apps/api/core';
import { call, errorText, type Profile } from '../../lib/ipc';
import { LoginLink } from '../../lib/loginLink';
import {
  applyChatEvent,
  canSend,
  initialChat,
  withLinkEnded,
  withNotice,
  withSent,
  type ChatEvent,
  type ChatState,
} from './chatState';

/** Where a chat's agent runs: on a saved SSH session's server, or on this PC (design §9.7). */
export type ChatPlace = { kind: 'ssh'; profile: Profile } | { kind: 'local'; name: string };

/** The tab title and the line under it. */
export const placeTitle = (place: ChatPlace) =>
  place.kind === 'ssh' ? place.profile.name : '이 PC';
export const placeDetail = (place: ChatPlace) =>
  place.kind === 'ssh' ? `${place.profile.username}@${place.profile.host}` : place.name;

/**
 * One chat tab (AC.1). Over SSH it owns a login-only connection and starts the agent once that
 * connection is up; a later connection would be a new conversation. On this PC it starts the
 * agent directly.
 */
export class ChatSession {
  readonly link = new LoginLink({
    connect: 'chat_open',
    disconnect: 'chat_close',
    connecting: '서버에 연결하는 중…',
  });
  private state = initialChat;
  private listeners = new Set<() => void>();
  /** The connection the agent was started on. */
  private started: string | null = null;

  constructor(
    readonly place: ChatPlace,
    readonly folder = '',
  ) {
    this.link.subscribe(this.follow);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  private set(next: ChatState) {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }

  open = () => {
    if (this.place.kind === 'ssh') return void this.link.open(this.place.profile);
    const id = crypto.randomUUID();
    this.started = id;
    void this.start(id, 'chat_start_local');
  };
  close = () => {
    if (this.place.kind === 'ssh') return this.link.release();
    const id = this.started;
    this.started = null;
    // The agent may already have exited; there is then nothing to stop.
    if (id) void call('chat_close', { id }).catch(() => {});
  };

  private follow = () => {
    const { id, status, message } = this.link.snapshot();
    if (status === 'connected' && id && this.started !== id) {
      this.started = id;
      void this.start(id, 'chat_start');
    } else if (status === 'closed' || status === 'error') {
      // Before the agent started, an error is a login that failed rather than a lost connection.
      const tone = status === 'error' && !this.started ? 'error' : 'info';
      this.set(withLinkEnded(this.state, message, tone));
    }
  };

  private async start(id: string, command: 'chat_start' | 'chat_start_local') {
    this.set({ ...this.state, phase: 'starting' });
    const channel = new Channel<ChatEvent>();
    channel.onmessage = (event) => {
      if (this.started === id) this.set(applyChatEvent(this.state, event));
    };
    try {
      await call(command, { id, folder: this.folder, onEvent: channel });
      if (this.started === id && this.state.phase === 'starting')
        this.set({ ...this.state, phase: 'ready' });
    } catch (e) {
      if (this.started === id)
        this.set(withNotice({ ...this.state, phase: 'ended' }, 'error', errorText(e)));
    }
  }

  /** Stops the running turn. The agent stays for the next message. */
  interrupt = async () => {
    const id = this.started;
    if (!id || this.state.phase !== 'working') return;
    this.set({ ...this.state, stopping: true });
    try {
      await call('chat_interrupt', { id });
    } catch (e) {
      this.set(withNotice({ ...this.state, stopping: false }, 'error', errorText(e)));
    }
  };

  /** False when the message could not be handed over; the reason is in the conversation. */
  send = async (text: string) => {
    const id = this.started;
    if (!id || !canSend(this.state) || !text.trim()) return false;
    this.set(withSent(this.state, text));
    try {
      await call('chat_send', { id, text });
      return true;
    } catch (e) {
      this.set(withNotice({ ...this.state, phase: 'ready' }, 'error', errorText(e)));
      return false;
    }
  };
}
