/** What the backend sends a chat tab (src-tauri/src/chat/event.rs). */
export type ChatEvent =
  | { kind: 'started'; session: string; model: string }
  | { kind: 'text'; text: string }
  | { kind: 'turnFinished'; ok: boolean; detail: string | null }
  | {
      kind: 'ended';
      reason: 'exited' | 'disconnected' | 'unreadable';
      detail: string | null;
    };

export type ChatItem =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'agent'; id: number; text: string }
  | { kind: 'notice'; id: number; tone: 'info' | 'error'; text: string };

/**
 * `connecting` until the login is done, `starting` while the agent launches, then `ready` and
 * `working` by turn. `ended` once the agent or its connection is gone.
 */
export type ChatPhase = 'connecting' | 'starting' | 'ready' | 'working' | 'ended';
export type ChatState = { phase: ChatPhase; model: string; items: ChatItem[]; next: number };

export const initialChat: ChatState = { phase: 'connecting', model: '', items: [], next: 1 };

type NewItem =
  | Omit<Extract<ChatItem, { kind: 'user' }>, 'id'>
  | Omit<Extract<ChatItem, { kind: 'agent' }>, 'id'>
  | Omit<Extract<ChatItem, { kind: 'notice' }>, 'id'>;

function add(state: ChatState, item: NewItem): ChatState {
  return { ...state, items: [...state.items, { ...item, id: state.next }], next: state.next + 1 };
}

export const withNotice = (state: ChatState, tone: 'info' | 'error', text: string) =>
  add(state, { kind: 'notice', tone, text });

const endings: Record<Extract<ChatEvent, { kind: 'ended' }>['reason'], [string, 'info' | 'error']> =
  {
    exited: ['에이전트가 종료되었습니다.', 'error'],
    disconnected: ['연결이 끊어졌습니다. 서버에서는 작업이 계속됩니다.', 'info'],
    unreadable: ['에이전트 출력을 읽지 못했습니다.', 'error'],
  };

export function applyChatEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.kind) {
    case 'started':
      return { ...state, model: event.model };
    case 'text':
      return add(state, { kind: 'agent', text: event.text });
    case 'turnFinished': {
      const next: ChatState = { ...state, phase: state.phase === 'ended' ? 'ended' : 'ready' };
      return event.ok
        ? next
        : withNotice(next, 'error', `작업이 실패했습니다. ${event.detail ?? ''}`.trim());
    }
    case 'ended': {
      const [text, tone] = endings[event.reason];
      return withNotice(
        { ...state, phase: 'ended' },
        tone,
        event.detail ? `${text}\n${event.detail}` : text,
      );
    }
  }
}

/** The user's message, shown at once. The agent reads it when the current turn allows. */
export const withSent = (state: ChatState, text: string): ChatState =>
  add({ ...state, phase: 'working' }, { kind: 'user', text });

/** Messages are accepted during a turn too: the agent folds them into it (AC.0 measurement). */
export const canSend = (state: ChatState) => state.phase === 'ready' || state.phase === 'working';

/** The connection ended without the agent saying so: a failed login or a broken network. */
export function withLinkEnded(
  state: ChatState,
  message: string,
  tone: 'info' | 'error' = 'info',
): ChatState {
  if (state.phase === 'ended') return state;
  return withNotice({ ...state, phase: 'ended' }, tone, message);
}
