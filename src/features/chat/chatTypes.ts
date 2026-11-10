/** What a chat is made of: the backend's events and the conversation's items. */
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
