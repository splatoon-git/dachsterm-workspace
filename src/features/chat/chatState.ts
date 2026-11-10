/** A file edit the agent asked for, cut short by the backend. `before` is empty for a new file. */
export type ChatEdit = { path: string; before: string; after: string };

/**
 * A model, command or agent the agent offers. `hint` is a command's arguments, or the full model
 * name a model choice stands for.
 */
export type ChatChoice = { value: string; label: string; detail: string; hint: string };
export type ChatContext = {
  percentage: number;
  used: number;
  max: number;
  parts: { name: string; tokens: number; free: boolean }[];
};
export type ChatAgent = {
  id: string;
  role: string;
  task: string;
  status: 'running' | 'done' | 'failed';
  summary: string;
};

/** What the backend sends a chat tab (src-tauri/src/chat/event.rs). */
export type ChatEvent =
  | { kind: 'started'; session: string; model: string }
  | { kind: 'textDelta'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; done: boolean }
  | { kind: 'toolStarted'; id: string; name: string; summary: string; edit: ChatEdit | null }
  | { kind: 'toolFinished'; id: string; ok: boolean; output: string }
  | {
      kind: 'capabilities';
      models: ChatChoice[];
      commands: ChatChoice[];
      agents: ChatChoice[];
      permissionMode: string;
    }
  | ({ kind: 'context' } & ChatContext)
  | { kind: 'agentStarted'; id: string; role: string; task: string }
  | { kind: 'agentFinished'; id: string; ok: boolean; summary: string }
  | { kind: 'problem'; text: string }
  | { kind: 'turnFinished'; ok: boolean; detail: string | null }
  | {
      kind: 'ended';
      reason: 'exited' | 'disconnected' | 'unreadable';
      detail: string | null;
    };

export type ChatItem =
  | { kind: 'user'; id: number; text: string }
  /** `streaming` while the reply is still being written. */
  | { kind: 'agent'; id: number; text: string; streaming: boolean }
  /** `seconds` once the thinking is over. */
  | { kind: 'thinking'; id: number; started: number; seconds: number | null }
  | {
      kind: 'tool';
      id: number;
      call: string;
      name: string;
      summary: string;
      edit: ChatEdit | null;
      status: 'running' | 'done' | 'failed';
      output: string;
    }
  | { kind: 'notice'; id: number; tone: 'info' | 'error'; text: string };

/**
 * `connecting` until the login is done, `starting` while the agent launches, then `ready` and
 * `working` by turn. `ended` once the agent or its connection is gone.
 */
export type ChatPhase = 'connecting' | 'starting' | 'ready' | 'working' | 'ended';
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
          : item,
    ),
  };
}

const endings: Record<Extract<ChatEvent, { kind: 'ended' }>['reason'], [string, 'info' | 'error']> =
  {
    exited: ['에이전트가 종료되었습니다.', 'error'],
    disconnected: ['연결이 끊어졌습니다. 서버에서는 작업이 계속됩니다.', 'info'],
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
      };
    case 'context': {
      const { percentage, used, max, parts } = event;
      return { ...state, context: { percentage, used, max, parts } };
    }
    case 'agentStarted':
      return {
        ...state,
        agents: [
          ...state.agents,
          { id: event.id, role: event.role, task: event.task, status: 'running', summary: '' },
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
  return withNotice({ ...settle(state), phase: 'ended' }, tone, message);
}

/** The model's name for the composer: what the user just picked, else what the agent runs. */
export function modelLabel(state: ChatState) {
  const { models } = state.offers;
  if (state.chosen) return models.find((m) => m.value === state.chosen)?.label ?? state.chosen;
  // A model choice's hint is the full name it stands for. `default` stands for one of the others.
  const named =
    models.find((m) => m.hint === state.model && m.value !== 'default') ??
    models.find((m) => m.hint === state.model);
  return named?.label ?? state.model;
}

/** The commands whose name starts with what follows `/`, while the draft is only a command. */
export function commandMatches(state: ChatState, draft: string) {
  const typed = /^\/(\S*)$/.exec(draft);
  if (!typed) return [];
  const word = typed[1].toLowerCase();
  return state.offers.commands.filter((c) => c.value.toLowerCase().startsWith(word));
}

/** Tokens as people read them: 980, 25.2k, 1.2M. */
export function tokenText(tokens: number) {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
