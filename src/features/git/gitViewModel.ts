import type { DiffChange } from './gitDiff';
import type { GitRepo } from './gitStatus';

/** The `git_view` reply (`git_status/view.rs`) and how its files read in the sidebar. */
export type GitViewEntry = {
  path: string;
  oldPath: string | null;
  index: DiffChange | null;
  worktree: DiffChange | null;
  /** False when the name is not UTF-8: it shows, but the shown name cannot be asked for. */
  readable: boolean;
};
export type GitViewRepo = Omit<GitRepo, 'entries'> & { entries: GitViewEntry[] };
export type GitViewResult =
  | GitViewRepo
  | { kind: 'notRepo'; detail: string }
  | { kind: 'noGit'; detail: string }
  | { kind: 'stopped'; reason: 'timeout' | 'tooLarge' };

export type GitGroupId = 'staged' | 'changes' | 'untracked' | 'conflict';
export type GitRow = {
  /** Unique across groups, since a file can be both staged and changed. */
  key: string;
  group: GitGroupId;
  path: string;
  oldPath: string | null;
  change: DiffChange;
  readable: boolean;
};
export type GitGroup = { id: GitGroupId; label: string; rows: GitRow[] };

const groupOrder: [GitGroupId, string][] = [
  ['staged', '스테이지됨'],
  ['changes', '변경'],
  ['untracked', '추적 안 함'],
  ['conflict', '충돌'],
];

/** One row per side a file changed on. A conflict or untracked file has only that row. */
export function groupEntries(entries: GitViewEntry[]): GitGroup[] {
  const rows = new Map<GitGroupId, GitRow[]>(groupOrder.map(([id]) => [id, []]));
  const add = (entry: GitViewEntry, group: GitGroupId, change: DiffChange) =>
    rows.get(group)!.push({
      key: `${group}:${entry.path}`,
      group,
      path: entry.path,
      oldPath: entry.oldPath,
      change,
      readable: entry.readable,
    });
  for (const entry of entries) {
    if (entry.index === 'conflict') add(entry, 'conflict', 'conflict');
    else if (entry.worktree === 'untracked') add(entry, 'untracked', 'untracked');
    else {
      if (entry.index) add(entry, 'staged', entry.index);
      if (entry.worktree) add(entry, 'changes', entry.worktree);
    }
  }
  return groupOrder
    .map(([id, label]) => ({ id, label, rows: rows.get(id)! }))
    .filter((group) => group.rows.length);
}

export function splitPath(path: string) {
  const at = path.lastIndexOf('/');
  return at < 0
    ? { name: path, folder: '' }
    : { name: path.slice(at + 1), folder: path.slice(0, at) };
}

export type GitTreeNode =
  | { kind: 'folder'; key: string; name: string; children: GitTreeNode[] }
  | { kind: 'file'; row: GitRow };

type Building = { folders: Map<string, Building>; files: GitRow[] };

function nodes(folder: Building, prefix: string): GitTreeNode[] {
  const folders = [...folder.folders]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, child]) => {
      const path = prefix ? `${prefix}/${name}` : name;
      const inner = nodes(child, path);
      // A folder holding only one folder reads as one row, `src/app`.
      const only = inner.length === 1 ? inner[0] : undefined;
      return only?.kind === 'folder'
        ? { ...only, name: `${name}/${only.name}` }
        : ({ kind: 'folder', key: path, name, children: inner } as GitTreeNode);
    });
  return [...folders, ...folder.files.map((row) => ({ kind: 'file', row }) as GitTreeNode)];
}

/** The rows of one group as folders, for the tree layout. */
export function buildTree(rows: GitRow[]): GitTreeNode[] {
  const root: Building = { folders: new Map(), files: [] };
  for (const row of rows) {
    let at = root;
    const parts = row.path.split('/');
    for (const part of parts.slice(0, -1)) {
      if (!at.folders.has(part)) at.folders.set(part, { folders: new Map(), files: [] });
      at = at.folders.get(part)!;
    }
    at.files.push(row);
  }
  return nodes(root, '');
}

export type GitListItem =
  | { kind: 'folder'; key: string; name: string; depth: number; folded: boolean }
  | { kind: 'file'; row: GitRow; depth: number };

/** What the tree shows now: the rows inside a folded folder are left out. */
export function flattenTree(
  tree: GitTreeNode[],
  folded: ReadonlySet<string>,
  group: GitGroupId,
  depth = 0,
): GitListItem[] {
  return tree.flatMap((node): GitListItem[] => {
    if (node.kind === 'file') return [{ kind: 'file', row: node.row, depth }];
    const key = `${group}/${node.key}`;
    const isFolded = folded.has(key);
    return [
      { kind: 'folder', key, name: node.name, depth, folded: isFolded },
      ...(isFolded ? [] : flattenTree(node.children, folded, group, depth + 1)),
    ];
  });
}

export const stoppedReason = {
  timeout: '조회가 오래 걸려 자동 조회를 멈췄습니다.',
  tooLarge: '변경이 너무 많아 자동 조회를 멈췄습니다.',
};
