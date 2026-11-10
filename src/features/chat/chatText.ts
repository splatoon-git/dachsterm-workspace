import type { ChatProgram } from './chatPlaces';
import type { ChatState } from './chatState';

/** How a chat's values read on screen and on the clipboard. Kept apart from the event reducer. */

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

/** Codex's modes: its sandbox and who answers approvals (design §3). */
const codexModes: typeof permissionModes = [
  {
    value: 'default',
    label: '기본',
    detail: '작업 폴더 안에서는 바로 하고, 그 밖의 파일이나 네트워크는 묻습니다.',
  },
  {
    value: 'readOnly',
    label: '읽기 전용',
    detail: '파일을 바꾸지 않습니다. 바꿔야 하면 묻습니다.',
  },
  { value: 'auto', label: '자동', detail: '승인이 필요한 동작은 검토 에이전트가 판단합니다.' },
  {
    value: 'bypassPermissions',
    label: '권한 확인 생략',
    detail: '샌드박스 없이 묻지 않고 파일을 바꾸고 명령을 실행합니다.',
    risky: true,
  },
];

/** The permission modes the chat's agent offers. */
export const modesOf = (program: ChatProgram) =>
  program === 'codex' ? codexModes : permissionModes;

/** A mode by its value. The two agents give a shared value the same meaning and label. */
export const modeOf = (mode: string) =>
  permissionModes.find((m) => m.value === mode) ?? codexModes.find((m) => m.value === mode);

export const modeLabel = (mode: string) => modeOf(mode)?.label ?? mode;

const effortNames: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
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
