/** What the Git view asks `git_apply` to do (`git_apply.rs`), and how its answers read. */
export type GitAction =
  | { kind: 'stage'; paths: string[] | null }
  | { kind: 'unstage'; paths: string[] | null }
  | { kind: 'commit'; message: string; amend: boolean }
  | { kind: 'discard'; paths: string[]; untracked: string[] }
  | { kind: 'branchCreate'; name: string }
  | { kind: 'checkout'; branch: string }
  | { kind: 'stashPush'; message: string; includeUntracked: boolean }
  | { kind: 'stashPop' }
  | { kind: 'tag'; name: string; message: string };

export type GitApplyResult =
  | { kind: 'done'; commands: string[] }
  | {
      kind: 'failed';
      commands: string[];
      reason: 'identity' | 'noGit' | 'timeout' | 'tooLarge' | 'git';
      detail: string;
    };

const failureAdvice = {
  identity: '커밋 작성자 이름·이메일이 없습니다. 설정 → Git에서 지정하세요.',
  noGit: '',
  timeout: 'Git 명령이 제한 시간을 넘겨 중단했습니다. 저장소 상태를 확인하세요.',
  tooLarge: 'Git 출력이 너무 많아 중단했습니다. 저장소 상태를 확인하세요.',
  git: '',
};

/** Git's own first line, after what the app can say about it. */
export function failureText(result: Extract<GitApplyResult, { kind: 'failed' }>) {
  const parts = [failureAdvice[result.reason], result.detail].filter(Boolean);
  return parts.join(' ') || 'Git 명령이 실패했습니다.';
}

/** What is typed in the terminal. They need answers the app cannot give: keys, tokens, host keys. */
export const networkCommands = {
  fetch: 'git fetch',
  pull: 'git pull',
  push: 'git push',
  forcePush: 'git push --force-with-lease',
} as const;

/**
 * A branch name that means the same in every shell, unquoted. Bash, Zsh, PowerShell and cmd quote
 * differently, so anything else is refused rather than quoted for the wrong one.
 */
export const safeTerminalWord = (name: string) =>
  /^[\p{L}\p{N}_][\p{L}\p{N}_./-]*$/u.test(name) && !name.includes('..');

/** The line that checks out a remote branch, or null when the name cannot be typed safely. */
export const trackCommand = (remote: string) =>
  safeTerminalWord(remote) ? `git checkout --track ${remote}` : null;

export type BranchChoices = { local: string[]; remote: string[] };

/**
 * Branches to switch to. A remote branch that has a local one of the same name is left out, since
 * switching to the local one is what is meant.
 */
export function branchChoices(refs: string[], current: string | null): BranchChoices {
  const heads = refs.flatMap((ref) =>
    ref.startsWith('refs/heads/') ? [ref.slice('refs/heads/'.length)] : [],
  );
  const known = new Set(heads);
  const remote = refs.flatMap((ref) => {
    if (!ref.startsWith('refs/remotes/')) return [];
    const name = ref.slice('refs/remotes/'.length);
    const short = name.slice(name.indexOf('/') + 1);
    return short === 'HEAD' || known.has(short) ? [] : [name];
  });
  return { local: heads.filter((name) => name !== current), remote };
}

export type BranchPick = { kind: 'create' | 'local' | 'remote'; name: string };

/** The rows of the branch picker, narrowed by what was typed. Creating one is always offered. */
export function branchPicks(choices: BranchChoices, filter: string): BranchPick[] {
  const wanted = filter.trim().toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(wanted);
  return [
    { kind: 'create', name: '' },
    ...choices.local.filter(matches).map((name): BranchPick => ({ kind: 'local', name })),
    ...choices.remote.filter(matches).map((name): BranchPick => ({ kind: 'remote', name })),
  ];
}

export type DiscardTarget = {
  paths: string[];
  untracked: string[];
  /** Files the list leaves out because their names are not readable. */
  omitted?: number;
};

export type GitDialogRequest =
  | { kind: 'discard'; target: DiscardTarget }
  | { kind: 'forcePush' }
  | { kind: 'terminal'; command: string }
  /** `name` starts the field, as what was typed while looking for a branch. */
  | { kind: 'branchCreate'; name?: string }
  | { kind: 'checkout' }
  | { kind: 'tag' }
  | { kind: 'stash' };

export type GitLogEntry = {
  id: number;
  command: string;
  where: 'app' | 'terminal';
  /** A typed command's result stays in the terminal, so it has none here. */
  result: 'done' | 'failed' | 'typed';
  detail: string;
};
