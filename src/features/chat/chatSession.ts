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

/**
 * One chat tab (AC.1): its login-only connection and the agent started on it. The agent starts
 * once per connection; a later connection would be a new conversation.
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
    readonly profile: Profile,
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

  open = () => void this.link.open(this.profile);
  close = () => this.link.release();

  private follow = () => {
    const { id, status, message } = this.link.snapshot();
    if (status === 'connected' && id && this.started !== id) {
      this.started = id;
      void this.start(id);
    } else if (status === 'closed' || status === 'error') {
      // Before the agent started, an error is a login that failed rather than a lost connection.
      const tone = status === 'error' && !this.started ? 'error' : 'info';
      this.set(withLinkEnded(this.state, message, tone));
    }
  };

  private async start(id: string) {
    this.set({ ...this.state, phase: 'starting' });
    const channel = new Channel<ChatEvent>();
    channel.onmessage = (event) => {
      if (this.started === id) this.set(applyChatEvent(this.state, event));
    };
    try {
      await call('chat_start', { id, folder: this.folder, onEvent: channel });
      if (this.started === id && this.state.phase === 'starting')
        this.set({ ...this.state, phase: 'ready' });
    } catch (e) {
      if (this.started === id)
        this.set(withNotice({ ...this.state, phase: 'ended' }, 'error', errorText(e)));
    }
  }

  /** False when the message could not be handed over; the reason is in the conversation. */
  send = async (text: string) => {
    const { id } = this.link.snapshot();
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
