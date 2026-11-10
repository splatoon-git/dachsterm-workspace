import type {
  ChatAgent,
  ChatChoice,
  ChatContext,
  ChatEvent,
  ChatItem,
  ChatLimit,
  ChatTurnUsage,
} from './chatTypes';

export type * from './chatTypes';

/**
 * `connecting` until the login is done, `starting` while the agent launches, then `ready` and
 * `working` by turn. `disconnected` while a server's agent works on with no connection to it,
 * and `ended` once the agent itself is gone.
 */
export type ChatPhase = 'connecting' | 'starting' | 'ready' | 'working' | 'disconnected' | 'ended';
export type ChatState = {
  phase: ChatPhase;
  /** The model the agent reported. `chosen` is what the user picked since, until it reports. */
  model: string;
  chosen: string;
  offers: { models: ChatChoice[]; commands: ChatChoice[]; agents: ChatChoice[] };
  permissionMode: string;
  context: ChatContext | null;
  /** Subagents of this chat, newest last. */
  agents: ChatAgent[];
  account: { plan: string; email: string } | null;
  effort: string;
  /** Ultracode for this session, as last set from this chat. The agent does not report it. */
  ultracode: boolean;
  /** The session's cost and edits, and the account's usage windows. */
  usage: { cost: number; added: number; removed: number } | null;
  limits: ChatLimit[];
  lastTurn: ChatTurnUsage | null;
  items: ChatItem[];
  next: number;
  /** The user asked to stop the running turn, so its failure is not an error. */
  stopping: boolean;
};

export const initialChat: ChatState = {
  phase: 'connecting',
  model: '',
  chosen: '',
  offers: { models: [], commands: [], agents: [] },
  permissionMode: '',
  context: null,
  agents: [],
  account: null,
  effort: '',
  ultracode: false,
  usage: null,
  limits: [],
  lastTurn: null,
  items: [],
  next: 1,
  stopping: false,
};

type Without<T> = T extends unknown ? Omit<T, 'id'> : never;

function add(state: ChatState, item: Without<ChatItem>): ChatState {
  return {
    ...state,
    items: [...state.items, { ...item, id: state.next } as ChatItem],
    next: state.next + 1,
  };
}

/** Replaces the last item that matches, or leaves the state alone. */
function updateLast<K extends ChatItem['kind']>(
  state: ChatState,
  kind: K,
  match: (item: Extract<ChatItem, { kind: K }>) => boolean,
  change: (item: Extract<ChatItem, { kind: K }>) => Extract<ChatItem, { kind: K }>,
): ChatState | null {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.kind === kind && match(item as Extract<ChatItem, { kind: K }>)) {
      const items = state.items.slice();
      items[i] = change(item as Extract<ChatItem, { kind: K }>);
      return { ...state, items };
    }
  }
  return null;
}

export const withNotice = (state: ChatState, tone: 'info' | 'error', text: string) =>
  add(state, { kind: 'notice', tone, text });

/** Nothing is still being written once a turn or the chat is over. */
function settle(state: ChatState): ChatState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === 'agent' && item.streaming
        ? { ...item, streaming: false }
        : item.kind === 'tool' && item.status === 'running'
          ? { ...item, status: 'failed' }
          : item.kind === 'approval' && item.status === 'pending'
            ? { ...item, status: 'expired' }
            : item,
    ),
  };
}

const endings: Record<Extract<ChatEvent, { kind: 'ended' }>['reason'], [string, 'info' | 'error']> =
  {
    exited: ['에이전트가 종료되었습니다.', 'error'],
    // Only a server's chat loses its connection, and it is not over then (`withDisconnected`).
    disconnected: ['연결이 끊어졌습니다.', 'info'],
    unreadable: ['에이전트 출력을 읽지 못했습니다.', 'error'],
  };

/** `now` stamps thinking, so its length can be shown. */
export function applyChatEvent(state: ChatState, event: ChatEvent, now = Date.now()): ChatState {
  switch (event.kind) {
    case 'started':
      return { ...state, model: event.model, chosen: '' };
    case 'capabilities':
      return {
        ...state,
        offers: { models: event.models, commands: event.commands, agents: event.agents },
        permissionMode: event.permissionMode,
        account: event.account,
      };
    case 'effort':
      return { ...state, effort: event.level };
    case 'mode':
      return { ...state, permissionMode: event.mode };
    case 'usage':
      return {
        ...state,
        usage: { cost: event.cost, added: event.added, removed: event.removed },
        limits: event.limits.length ? event.limits : state.limits,
      };
    case 'limits':
      return { ...state, limits: event.limits };
    case 'turnUsage': {
      const { input, cacheRead, cacheWrite, output, cost } = event;
      return { ...state, lastTurn: { input, cacheRead, cacheWrite, output, cost } };
    }
    case 'context': {
      const { percentage, used, max, parts } = event;
      // Known here before the first turn names it.
      return {
        ...state,
        model: state.model || event.model,
        context: { percentage, used, max, parts },
      };
    }
    case 'agentStarted':
      return {
        ...state,
        agents: [
          ...state.agents,
          {
            id: event.id,
            call: event.call,
            role: event.role,
            task: event.task,
            status: 'running',
            summary: '',
          },
        ],
      };
    case 'agentFinished':
      return {
        ...state,
        agents: state.agents.map((agent) =>
          agent.id === event.id
            ? { ...agent, status: event.ok ? 'done' : 'failed', summary: event.summary }
            : agent,
        ),
      };
    case 'approvalAsked': {
      const { request, tool, summary, detail, edit, questions } = event;
      return add(state, {
        kind: 'approval',
        request,
        tool,
        summary,
        detail,
        edit,
        questions,
        status: 'pending',
        auto: false,
        answer: '',
      });
    }
    case 'problem':
      return withNotice({ ...state, chosen: '' }, 'error', event.text);
    case 'textDelta': {
      const last = state.items.at(-1);
      if (last?.kind === 'agent' && last.streaming)
        return updateLast(
          state,
          'agent',
          (i) => i === last,
          (i) => ({
            ...i,
            text: i.text + event.text,
          }),
        )!;
      return add(state, { kind: 'agent', text: event.text, streaming: true });
    }
    case 'text':
      // The finished block replaces what was streamed for it, which may have missed pieces.
      return (
        updateLast(
          state,
          'agent',
          (i) => i.streaming,
          (i) => ({
            ...i,
            text: event.text,
            streaming: false,
          }),
        ) ?? add(state, { kind: 'agent', text: event.text, streaming: false })
      );
    case 'thinking':
      if (!event.done) return add(state, { kind: 'thinking', started: now, seconds: null });
      return (
        updateLast(
          state,
          'thinking',
          (i) => i.seconds === null,
          (i) => ({
            ...i,
            seconds: Math.max(1, Math.round((now - i.started) / 1000)),
          }),
        ) ?? state
      );
    case 'toolStarted':
      return add(settle(state), {
        kind: 'tool',
        call: event.id,
        name: event.name,
        summary: event.summary,
        edit: event.edit,
        status: 'running',
        output: '',
      });
    case 'toolFinished':
      return (
        updateLast(
          state,
          'tool',
          (i) => i.call === event.id,
          (i) => ({
            ...i,
            status: event.ok ? 'done' : 'failed',
            output: event.output,
          }),
        ) ?? state
      );
    case 'turnFinished': {
      const next: ChatState = {
        ...settle(state),
        phase: state.phase === 'ended' ? 'ended' : 'ready',
        stopping: false,
      };
      if (event.ok) return next;
      if (state.stopping) return withNotice(next, 'info', '중지했습니다.');
      return withNotice(next, 'error', `작업이 실패했습니다. ${event.detail ?? ''}`.trim());
    }
    case 'ended': {
      if (event.reason === 'disconnected') return withDisconnected(state);
      const [text, tone] = endings[event.reason];
      return withNotice(
        { ...settle(state), phase: 'ended' },
        tone,
        event.detail ? `${text}\n${event.detail}` : text,
      );
    }
  }
}

/** The user's message, shown at once. The agent reads it when the current turn allows. */
export const withSent = (state: ChatState, text: string, files: string[] = []): ChatState =>
  add({ ...state, phase: 'working' }, { kind: 'user', text, files });

/** Messages are accepted during a turn too: the agent folds them into it (AC.0 measurement). */
export const canSend = (state: ChatState) => state.phase === 'ready' || state.phase === 'working';

/** The connection ended before the agent started: a failed login or a broken network. */
export function withLinkEnded(
  state: ChatState,
  message: string,
  tone: 'info' | 'error' = 'info',
): ChatState {
  if (state.phase === 'ended' || state.phase === 'disconnected') return state;
  return withNotice({ ...settle(state), phase: 'ended' }, tone, message);
}

/**
 * A server's agent lost its connection but goes on (AC.1 measurement). Nothing is settled: a reply,
 * a tool or an approval carries on from where it was once the chat is attached again.
 */
export function withDisconnected(state: ChatState): ChatState {
  if (state.phase === 'disconnected' || state.phase === 'ended') return state;
  return withNotice(
    { ...state, phase: 'disconnected', stopping: false },
    'info',
    '연결이 끊어졌습니다. 서버에서는 작업이 계속되며, 다시 연결하면 이어서 봅니다.',
  );
}

/**
 * Attached again. A turn may have ended while away; its end comes with the output read next, so
 * until then the chat is taken to be working if it was, or if it waits for an answer.
 */
export function withReattached(state: ChatState, wasWorking: boolean): ChatState {
  if (state.phase !== 'disconnected') return state;
  const phase = wasWorking || waitsForUser(state) ? 'working' : 'ready';
  return withNotice({ ...state, phase }, 'info', '다시 연결했습니다.');
}

/** Marks an approval as answered: allowed, refused, or allowed with a question's answer. */
export function withAnswered(
  state: ChatState,
  request: string,
  status: 'allowed' | 'denied',
  extra: { auto?: boolean; answer?: string } = {},
): ChatState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === 'approval' && item.request === request ? { ...item, status, ...extra } : item,
    ),
  };
}

/** Whether the agent is waiting for the user. */
export const waitsForUser = (state: ChatState) =>
  state.items.some((item) => item.kind === 'approval' && item.status === 'pending');
