/** A file edit the agent asked for, cut short by the backend. `before` is empty for a new file. */
export type ChatEdit = { path: string; before: string; after: string };

/**
 * A model, command or agent the agent offers. `hint` is a command's arguments, or the full model
 * name a model choice stands for.
 */
export type ChatChoice = {
  value: string;
  label: string;
  detail: string;
  hint: string;
  /** A model's effort levels. */
  levels: string[];
};
/** A usage window: `five_hour` or `seven_day`. `resetsAt` is RFC 3339 or Unix seconds. */
export type ChatLimit = { name: string; percent: number; resetsAt: string };
export type ChatTurnUsage = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost: number;
};
export type ChatContext = {
  percentage: number;
  used: number;
  max: number;
  parts: { name: string; tokens: number; free: boolean }[];
};
export type ChatAgent = {
  id: string;
  /** The tool call that started it. */
  call: string;
  role: string;
  task: string;
  status: 'running' | 'done' | 'failed';
  summary: string;
};

/** One question of the agent's question tool. `multi` allows more than one option. */
export type ChatQuestion = {
  question: string;
  header: string;
  multi: boolean;
  options: { label: string; detail: string }[];
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
      account: { plan: string; email: string };
    }
  | { kind: 'effort'; level: string }
  | { kind: 'mode'; mode: string }
  | { kind: 'usage'; cost: number; added: number; removed: number; limits: ChatLimit[] }
  | { kind: 'limits'; limits: ChatLimit[] }
  | ({ kind: 'turnUsage' } & ChatTurnUsage)
  | ({ kind: 'context'; model: string } & ChatContext)
  | { kind: 'agentStarted'; id: string; call: string; role: string; task: string }
  | { kind: 'agentFinished'; id: string; ok: boolean; summary: string }
  | { kind: 'problem'; text: string }
  | {
      kind: 'approvalAsked';
      request: string;
      tool: string;
      summary: string;
      detail: string;
      edit: ChatEdit | null;
      questions: ChatQuestion[];
    }
  | { kind: 'turnFinished'; ok: boolean; detail: string | null }
  | {
      kind: 'ended';
      reason: 'exited' | 'disconnected' | 'unreadable';
      detail: string | null;
    };

export type ChatItem =
  /** `files` are the attachments' names, shown under the words. */
  | { kind: 'user'; id: number; text: string; files: string[] }
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
  | { kind: 'notice'; id: number; tone: 'info' | 'error'; text: string }
  /**
   * The agent waits for the user before a tool call. `auto` marks one allowed by an earlier
   * "for this chat" answer; `answer` is what the user chose for a question.
   */
  | {
      kind: 'approval';
      id: number;
      request: string;
      tool: string;
      summary: string;
      detail: string;
      edit: ChatEdit | null;
      questions: ChatQuestion[];
      status: 'pending' | 'allowed' | 'denied' | 'expired';
      auto: boolean;
      answer: string;
    };

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

/** The permission modes offered, in the agent's names, with what each means for this chat. */
export const permissionModes: { value: string; label: string; detail: string; risky?: true }[] = [
  {
    value: 'default',
    label: '기본',
    detail: '파일 편집이나 명령 실행처럼 승인이 필요한 동작은 묻습니다.',
  },
  { value: 'acceptEdits', label: '편집 자동 승인', detail: '파일 편집은 묻지 않고 합니다.' },
  { value: 'plan', label: '계획', detail: '읽기만 하고 계획을 제안합니다.' },
  { value: 'auto', label: '자동', detail: '안전해 보이는 동작은 에이전트가 알아서 합니다.' },
  {
    value: 'bypassPermissions',
    label: '권한 확인 생략',
    detail: '묻지 않고 파일을 바꾸고 명령을 실행합니다.',
    risky: true,
  },
];

export const modeLabel = (mode: string) =>
  permissionModes.find((m) => m.value === mode)?.label ?? mode;

const effortNames: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};
export const effortLabel = (level: string) => effortNames[level] ?? level;

/** The effort levels the model in use takes. */
export function effortLevels(state: ChatState) {
  const { models } = state.offers;
  const current =
    models.find((m) => m.value === state.chosen) ??
    models.find((m) => m.hint === state.model && m.value !== 'default') ??
    models.find((m) => m.hint === state.model);
  return current?.levels ?? [];
}

export const limitLabel = (name: string) =>
  name === 'five_hour' ? '5시간' : name === 'seven_day' ? '7일' : name;

const two = (n: number) => String(n).padStart(2, '0');

/** When a usage window starts over, as a short phrase. */
export function resetText(resetsAt: string, now = Date.now()) {
  const at = /^\d+$/.test(resetsAt) ? Number(resetsAt) * 1000 : Date.parse(resetsAt);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((at - now) / 60000));
  if (minutes < 60) return `${minutes}분 후 초기화`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 후 초기화`;
  const date = new Date(at);
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${two(date.getHours())}:${two(date.getMinutes())} 초기화`;
}

export const costText = (usd: number) => `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;

/** The conversation as Markdown, for the clipboard. Tool output is left out; its line stays. */
export function chatTranscript(state: ChatState) {
  return state.items
    .flatMap((item) => {
      switch (item.kind) {
        case 'user':
          return [
            `**나:** ${item.text}${item.files.length ? ` (첨부: ${item.files.join(', ')})` : ''}`,
          ];
        case 'agent':
          return [item.text];
        case 'tool':
          return [`- \`${item.name}\` ${item.summary}`.trimEnd()];
        case 'notice':
          return [`> ${item.text.replace(/\n/g, '\n> ')}`];
        case 'thinking':
          return [];
      }
    })
    .join('\n\n');
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

const editTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * What "allow for this chat" covers: every file edit, the same command again, or the same tool.
 * The agent's own way of widening a permission did not hold in this mode (AC.5 measurement), so
 * the app remembers it for the chat instead.
 */
export function approvalScope(tool: string, summary: string) {
  if (editTools.has(tool)) return 'edit';
  if (tool === 'Bash') return `Bash ${summary}`;
  return tool;
}

/** How a card names what "allow for this chat" will cover. */
export function scopeText(tool: string) {
  if (editTools.has(tool)) return '이 채팅에서 파일 편집은 묻지 않기';
  if (tool === 'Bash') return '이 채팅에서 이 명령은 묻지 않기';
  return `이 채팅에서 ${tool}은(는) 묻지 않기`;
}

/** Whether the agent is waiting for the user. */
export const waitsForUser = (state: ChatState) =>
  state.items.some((item) => item.kind === 'approval' && item.status === 'pending');
