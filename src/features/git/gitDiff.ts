/** Replies of the diff review commands (DX.6, `git_diff.rs`) and how they read. */
export type DiffBase = { kind: 'workingTree' } | { kind: 'branch'; ref: string };
export type GitWorktree = { path: string; branch: string | null };
export type GitRefs = {
  root: string;
  worktrees: GitWorktree[];
  /** Full names under refs/heads/ and refs/remotes/. */
  refs: string[];
  truncated: boolean;
};
export type DiffChange =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typeChanged'
  | 'conflict'
  | 'untracked';
export type DiffFile = {
  path: string;
  oldPath: string | null;
  change: DiffChange;
  added: number | null;
  removed: number | null;
  binary: boolean;
  /** False when the name is not UTF-8: it shows, but the shown name cannot be asked for. */
  readable: boolean;
};
export type DiffList =
  | { kind: 'files'; files: DiffFile[]; truncated: boolean }
  | { kind: 'stopped'; reason: 'timeout' | 'tooLarge' };
export type FileDiff =
  { kind: 'text'; text: string } | { kind: 'tooLarge'; size: number | null } | { kind: 'timedOut' };

export const refLabel = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, '');
export const sameBase = (a: DiffBase, b: DiffBase) =>
  a.kind === b.kind && (a.kind === 'workingTree' || a.ref === (b as typeof a).ref);

export const changeMark: Record<DiffChange, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typeChanged: 'T',
  conflict: 'U',
  untracked: '?',
};
export const changeLabel: Record<DiffChange, string> = {
  modified: '수정',
  added: '추가',
  deleted: '삭제',
  renamed: '이름 변경',
  copied: '복사',
  typeChanged: '종류 변경',
  conflict: '충돌',
  untracked: '추적 안 함',
};

/** POSIX single quotes, for a command the user copies into a shell. */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The same diff in a terminal, for a file the review does not show. */
export function terminalCommand(base: DiffBase, file: DiffFile) {
  const path = shellQuote(file.path);
  if (file.change === 'untracked') return `git diff --no-index -- /dev/null ${path}`;
  const from =
    base.kind === 'workingTree'
      ? 'HEAD'
      : `"$(git merge-base HEAD ${shellQuote(refLabel(base.ref))})"`;
  const paths = file.oldPath ? `${shellQuote(file.oldPath)} ${path}` : path;
  return `git diff ${from} -- ${paths}`;
}

export function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
