import type { Source } from '../../lib/source';

/** Where a `git config` command runs and which file it changes (`git_config.rs`). */
export type GitConfigScope = { kind: 'global' } | { kind: 'local'; folder: string };
export type GitConfigTarget = {
  id: string;
  label: string;
  source: Source;
  scope: GitConfigScope;
};

export type GitConfigEntry = { key: string; values: string[]; hidden: boolean };
export type GitConfigChange =
  | { op: 'set'; key: string; value: string; all: boolean }
  | { op: 'unset'; key: string; all: boolean }
  | { op: 'add'; key: string; value: string };

export type GitConfigField =
  | { key: string; label: string; kind: 'text'; placeholder?: string }
  | { key: string; label: string; kind: 'choice'; choices: readonly (readonly [string, string])[] }
  /** Shown as it is and replaced only by a value the user types. */
  | { key: string; label: string; kind: 'typed' }
  /** A list that only grows here. */
  | { key: string; label: string; kind: 'list' };

const onOff = [
  ['true', '켬 (true)'],
  ['false', '끔 (false)'],
] as const;

/** The same keys as `FIELDS` in `git_config.rs`, which refuses anything else. */
const fields: readonly GitConfigField[] = [
  { key: 'user.name', label: '이름 (user.name)', kind: 'text' },
  { key: 'user.email', label: '이메일 (user.email)', kind: 'text' },
  {
    key: 'init.defaultBranch',
    label: '새 저장소 기본 브랜치 (init.defaultBranch)',
    kind: 'text',
    placeholder: '예: main',
  },
  {
    key: 'pull.rebase',
    label: 'pull 방식 (pull.rebase)',
    kind: 'choice',
    choices: [
      ['false', '병합 (false)'],
      ['true', '리베이스 (true)'],
      ['merges', '병합 커밋 유지 리베이스 (merges)'],
    ],
  },
  {
    key: 'pull.ff',
    label: 'pull 빨리 감기 (pull.ff)',
    kind: 'choice',
    choices: [
      ['true', '가능하면 (true)'],
      ['false', '항상 병합 커밋 (false)'],
      ['only', '빨리 감기만 (only)'],
    ],
  },
  {
    key: 'fetch.prune',
    label: 'fetch 때 지운 원격 브랜치 정리 (fetch.prune)',
    kind: 'choice',
    choices: onOff,
  },
  {
    key: 'push.autoSetupRemote',
    label: '첫 push에 업스트림 자동 설정 (push.autoSetupRemote)',
    kind: 'choice',
    choices: onOff,
  },
  {
    key: 'push.default',
    label: 'push 대상 (push.default)',
    kind: 'choice',
    choices: [
      ['simple', 'simple'],
      ['current', 'current'],
      ['upstream', 'upstream'],
      ['matching', 'matching'],
      ['nothing', 'nothing'],
    ],
  },
  {
    key: 'core.autocrlf',
    label: '줄바꿈 변환 (core.autocrlf)',
    kind: 'choice',
    choices: [
      ['true', 'CRLF로 받기 (true)'],
      ['input', '커밋할 때만 LF로 (input)'],
      ['false', '바꾸지 않음 (false)'],
    ],
  },
  {
    key: 'core.eol',
    label: '작업 트리 줄바꿈 (core.eol)',
    kind: 'choice',
    choices: [
      ['lf', 'LF'],
      ['crlf', 'CRLF'],
      ['native', 'OS 기본 (native)'],
    ],
  },
  {
    key: 'core.editor',
    label: '커밋 메시지 편집기 (core.editor)',
    kind: 'text',
    placeholder: '예: vim',
  },
  {
    key: 'merge.conflictStyle',
    label: '충돌 표시 (merge.conflictStyle)',
    kind: 'choice',
    choices: [
      ['merge', 'merge'],
      ['diff3', 'diff3'],
      ['zdiff3', 'zdiff3'],
    ],
  },
  {
    key: 'rebase.autoStash',
    label: '리베이스 전 자동 stash (rebase.autoStash)',
    kind: 'choice',
    choices: onOff,
  },
  {
    key: 'rerere.enabled',
    label: '충돌 해결 기억 (rerere.enabled)',
    kind: 'choice',
    choices: onOff,
  },
  { key: 'credential.helper', label: '자격 증명 도우미 (credential.helper)', kind: 'typed' },
  { key: 'safe.directory', label: '신뢰하는 폴더 (safe.directory)', kind: 'list' },
];

/** Git reads `safe.directory` only from system, global and command line settings. */
export const fieldsFor = (scope: GitConfigScope) =>
  scope.kind === 'local' ? fields.filter((field) => field.kind !== 'list') : fields;

export const entryOf = (entries: GitConfigEntry[], key: string) =>
  entries.find((entry) => entry.key === key);

/** The last value of a setting is the one Git uses. */
export const currentValue = (entry: GitConfigEntry | undefined) => entry?.values.at(-1) ?? '';

/** Only what the user changed: an edit back to the same value is no change. */
export function changesOf(
  fieldList: readonly GitConfigField[],
  entries: GitConfigEntry[],
  draft: Record<string, string>,
): GitConfigChange[] {
  const changes: GitConfigChange[] = [];
  for (const field of fieldList) {
    if (!(field.key in draft)) continue;
    const { key } = field;
    const next = draft[key].trim();
    const entry = entryOf(entries, key);
    const all = (entry?.values.length ?? 0) > 1;
    if (field.kind === 'list') {
      if (next && !entry?.values.includes(next)) changes.push({ op: 'add', key, value: next });
    } else if (field.kind === 'typed') {
      if (next && next !== currentValue(entry)) changes.push({ op: 'set', key, value: next, all });
    } else if (next !== currentValue(entry)) {
      if (next) changes.push({ op: 'set', key, value: next, all });
      else if (entry) changes.push({ op: 'unset', key, all });
    }
  }
  return changes;
}

/** `*` makes Git trust every repository on the target, whoever owns it. */
export const trustsEverything = (changes: GitConfigChange[]) =>
  changes.some((c) => c.op === 'add' && c.key === 'safe.directory' && c.value.trim() === '*');
