import { Channel } from '@tauri-apps/api/core';
import { call, errorText, type Profile } from '../../lib/ipc';
import { LoginLink } from '../../lib/loginLink';
import { withAttachments, type ChatAttachment } from './chatAttachments';
import {
  applyChatEvent,
  withAnswered,
  canSend,
  initialChat,
  withDisconnected,
  withLinkEnded,
  withNotice,
  withReattached,
  withSent,
  type ChatEvent,
  type ChatState,
} from './chatState';
import { approvalScope } from './chatText';

/**
 * Where a chat's agent runs: on a saved SSH session's server, or on this PC (design §9.7). `via`
 * names a terminal's connection to the same server that the chat may share, when it has one: no
 * second login, and no second one-time password (§9.7).
 */
export type ChatPlace =
  { kind: 'ssh'; profile: Profile; via?: () => string | null } | { kind: 'local'; name: string };

/** The tab title and the line under it. */
export const placeTitle = (place: ChatPlace) =>
  place.kind === 'ssh' ? place.profile.name : '이 PC';
export const placeDetail = (place: ChatPlace) =>
  place.kind === 'ssh' ? `${place.profile.username}@${place.profile.host}` : place.name;

/**
 * One chat tab (AC.1). Over SSH the agent runs detached on the server and the chat reaches it
 * through a terminal's connection or a login-only one of its own. When that connection is lost the
 * agent goes on, and `reconnect` attaches again where reading stopped (AC.9). On this PC the agent
 * is a child process of the app.
 */
export class ChatSession {
  /** The backend's name for this chat. It stays the same across connections. */
  readonly id = crypto.randomUUID();
  readonly link = new LoginLink({
    connect: 'chat_open',
    disconnect: 'chat_disconnect',
    connecting: '서버에 연결하는 중…',
  });
  private state = initialChat;
  private listeners = new Set<() => void>();
  /** What the user allowed "for this chat", by `approvalScope`. */
  private trusted = new Set<string>();
  /** Whether the backend has the agent, so a new connection attaches rather than starts. */
  private started = false;
  /** The SSH connection the agent is reached through now. */
  private connection: string | null = null;
  /** Events of an earlier reading, which may still arrive, are dropped by this token. */
  private reading = 0;
  /** Whether a turn was running when the connection was lost. */
  private wasWorking = false;
  private closed = false;

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
    if (this.place.kind === 'local') return void this.start(null);
    this.connect();
  };
  /** A terminal's connection when one is up, else a login of the chat's own. */
  private connect() {
    if (this.place.kind !== 'ssh') return;
    const shared = this.place.via?.();
    if (!shared) return void this.link.open(this.place.profile);
    this.link.release();
    this.joined(shared);
  }
  /** Connects again after the connection was lost, and reads on from where it stopped. */
  reconnect = () => {
    if (this.state.phase === 'disconnected') this.connect();
  };
  /** Ends the agent, then lets go of the chat's own connection, which the ending needs. */
  close = () => {
    this.closed = true;
    this.reading++;
    // A start that failed half way may have left the agent; the backend ignores an unknown chat.
    // An agent out of reach because the chat is disconnected is left on the server (AC.9).
    void call('chat_close', { id: this.id })
      .catch(() => {})
      .finally(() => this.link.release());
  };
  /** Gives up a login that asks for something. A chat that was running stays, to try again. */
  cancelLogin = () => {
    this.link.release();
    if (!this.started) this.set(withLinkEnded(this.state, '로그인을 취소했습니다.'));
  };

  private follow = () => {
    const { id, status, message } = this.link.snapshot();
    if (status === 'connected' && id && this.connection !== id) this.joined(id);
    else if ((status === 'closed' || status === 'error') && id === this.connection) this.lost();
    else if ((status === 'closed' || status === 'error') && !this.started)
      // Before the agent started, an error is a login that failed rather than a lost connection.
      this.set(withLinkEnded(this.state, message, status === 'error' ? 'error' : 'info'));
    else if (status === 'error' && this.state.phase === 'disconnected')
      // A login to reconnect failed. The chat stays as it was, ready for another try.
      this.set(withNotice(this.state, 'error', message));
  };

  /** A connection is up: the agent starts on it, or, if it already runs, is attached again. */
  private joined(connection: string) {
    this.connection = connection;
    if (this.started) void this.attach(connection);
    else void this.start(connection);
  }

  /** The connection is gone. A server's agent goes on, so the chat waits to be attached again. */
  private lost() {
    if (this.closed || this.state.phase === 'disconnected' || this.state.phase === 'ended') return;
    this.wasWorking = this.state.phase === 'working';
    this.connection = null;
    this.reading++;
    this.set(withDisconnected(this.state));
  }

  /** A channel for one reading of the agent's output. A later reading silences it. */
  private channel() {
    const token = ++this.reading;
    const channel = new Channel<ChatEvent>();
    channel.onmessage = (event) => {
      if (this.reading !== token) return;
      if (event.kind === 'ended' && event.reason === 'disconnected') return this.lost();
      this.set(applyChatEvent(this.state, event));
      if (
        event.kind === 'approvalAsked' &&
        !event.questions.length &&
        this.trusted.has(approvalScope(event.tool, event.summary))
      )
        void this.answer(event.request, 'allow', { auto: true });
      // The context use changes with every turn; the agent answers in its own time.
      if (event.kind === 'turnFinished' || event.kind === 'capabilities')
        void this.refreshContext();
    };
    return channel;
  }

  /** Starts the agent: on a server through `connection`, or on this PC when it is null. */
  private async start(connection: string | null) {
    this.set({ ...this.state, phase: 'starting' });
    // Taken before the channel, which cannot be made outside the desktop app.
    const token = this.reading + 1;
    try {
      const args = { id: this.id, folder: this.folder, onEvent: this.channel() };
      if (connection) await call('chat_start', { ...args, connection });
      else await call('chat_start_local', args);
      this.started = true;
      if (this.reading === token && this.state.phase === 'starting')
        this.set({ ...this.state, phase: 'ready' });
    } catch (e) {
      if (this.reading === token)
        this.set(withNotice({ ...this.state, phase: 'ended' }, 'error', errorText(e)));
    }
  }

  private async attach(connection: string) {
    const token = this.reading + 1;
    // Output read next may end the turn at once, so the phase is set before reading starts.
    const before = this.state;
    this.set(withReattached(this.state, this.wasWorking));
    try {
      await call('chat_attach', { id: this.id, connection, onEvent: this.channel() });
    } catch (e) {
      if (this.reading !== token) return;
      this.connection = null;
      this.set(withNotice(before, 'error', errorText(e)));
    }
  }

  private refreshContext = async () => {
    if (!this.live()) return;
    const id = this.id;
    // Not worth a message in the conversation: the indicators just keep their last values.
    await call('chat_context', { id }).catch(() => {});
    await call('chat_usage', { id }).catch(() => {});
  };

  /** Whether the agent can be reached now. */
  private live() {
    return this.started && (this.place.kind === 'local' || this.connection !== null);
  }

  /** Changes the effort for the next turns. */
  setEffort = async (level: string) => {
    const id = this.id;
    if (!this.live() || this.state.phase === 'ended') return;
    const before = this.state.effort;
    this.set({ ...this.state, effort: level });
    try {
      await call('chat_set_effort', { id, level });
    } catch (e) {
      this.set(withNotice({ ...this.state, effort: before }, 'error', errorText(e)));
    }
  };

  /** Ultracode runs as a short turn of its own, so it waits until no turn is running. */
  setUltracode = async (on: boolean) => {
    const id = this.id;
    if (!this.live() || this.state.phase !== 'ready') return;
    this.set({ ...this.state, ultracode: on, phase: 'working' });
    try {
      await call('chat_set_ultracode', { id, on });
    } catch (e) {
      this.set(
        withNotice({ ...this.state, ultracode: !on, phase: 'ready' }, 'error', errorText(e)),
      );
    }
  };

  /**
   * Answers an approval: allow once, allow for this chat, refuse, or answer a question with
   * `answers` (question to chosen labels).
   */
  answer = async (
    request: string,
    decision: 'allow' | 'chat' | 'deny',
    extra: { auto?: boolean; answers?: Record<string, string> } = {},
  ) => {
    const id = this.id;
    const item = this.state.items.find((i) => i.kind === 'approval' && i.request === request);
    if (!this.live() || item?.kind !== 'approval' || item.status !== 'pending') return;
    if (decision === 'chat') this.trusted.add(approvalScope(item.tool, item.summary));
    const allow = decision !== 'deny';
    const answer = extra.answers ? Object.values(extra.answers).join(' · ') : '';
    this.set(
      withAnswered(this.state, request, allow ? 'allowed' : 'denied', { auto: extra.auto, answer }),
    );
    try {
      await call('chat_answer', { id, request, allow, answers: extra.answers ?? null });
    } catch (e) {
      this.set(withNotice(this.state, 'error', errorText(e)));
    }
  };

  /** Changes the permission mode. The agent confirms it, or the chat says why not. */
  setMode = async (mode: string) => {
    const id = this.id;
    if (!this.live() || this.state.phase === 'ended') return;
    try {
      await call('chat_set_mode', { id, mode });
    } catch (e) {
      this.set(withNotice(this.state, 'error', errorText(e)));
    }
  };

  /** Switches the model for the next turns. A refusal comes back as a problem in the chat. */
  setModel = async (model: string) => {
    const id = this.id;
    if (!this.live() || this.state.phase === 'ended') return;
    this.set({ ...this.state, chosen: model });
    try {
      await call('chat_set_model', { id, model });
    } catch (e) {
      this.set(withNotice({ ...this.state, chosen: '' }, 'error', errorText(e)));
    }
  };

  /** Stops the running turn. The agent stays for the next message. */
  interrupt = async () => {
    const id = this.id;
    if (!this.live() || this.state.phase !== 'working') return;
    this.set({ ...this.state, stopping: true });
    try {
      await call('chat_interrupt', { id });
    } catch (e) {
      this.set(withNotice({ ...this.state, stopping: false }, 'error', errorText(e)));
    }
  };

  /** False when the message could not be handed over; the reason is in the conversation. */
  send = async (text: string, attachments: ChatAttachment[] = []) => {
    const id = this.id;
    if (!this.live() || !canSend(this.state) || (!text.trim() && !attachments.length)) return false;
    const before = this.state.phase;
    this.set(
      withSent(
        this.state,
        text,
        attachments.map((a) => a.name),
      ),
    );
    try {
      const paths: string[] = [];
      for (const attachment of attachments) paths.push(await this.readablePath(attachment));
      await call('chat_send', { id, text: withAttachments(text, paths) });
      return true;
    } catch (e) {
      this.set(withNotice({ ...this.state, phase: before }, 'error', errorText(e)));
      return false;
    }
  };

  /**
   * Where the agent can read an attachment. On a server it is uploaded first; on this PC a file
   * is already readable and only a clipboard image needs a file.
   */
  private readablePath = async (attachment: ChatAttachment): Promise<string> => {
    // Uploads go over the connection the agent is reached through.
    const id = this.connection;
    const remote = this.place.kind === 'ssh';
    if (attachment.kind === 'clipboard')
      return remote
        ? call<string>('prompt_clipboard_image', { id, expected: attachment.digest })
        : call<string>('chat_clipboard_local', { expected: attachment.digest });
    if (!remote) return attachment.path;
    const [path] = await call<string[]>('prompt_files_upload', { id, paths: [attachment.path] });
    return path;
  };
}
