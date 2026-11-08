import { fileMarkLabels, type FileMark } from '../../components/fileDecorations';
import type { GitDisplay } from '../../lib/gitDisplay';

/**
 * Git status of a tab's folder (DX.5, local and WSL tabs DX.15): when to ask, and how a result
 * reads. Folders are given in `gitPath` spelling.
 */
export type GitMark = Exclude<FileMark, 'folder'>;
export type GitRepo = {
  kind: 'repo';
  root: string;
  branch: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: { path: string; mark: GitMark }[];
  truncated: boolean;
};
/** The `git_status` reply. Anything but a repository shows nothing unless the user asked. */
export type GitResult =
  | GitRepo
  | { kind: 'notRepo'; detail: string }
  | { kind: 'stopped'; reason: 'timeout' | 'tooLarge' };
export type GitView = { repo: GitRepo } | { stopped: 'timeout' | 'tooLarge' } | null;

/** What happened. The query runs at once unless the same folder was asked about too recently. */
export type GitEvent =
  'folder' | 'refresh' | 'prompt' | 'activate' | 'program' | 'manual' | 'branch';
export const minInterval: Record<GitEvent, number> = {
  folder: 500,
  refresh: 500,
  prompt: 5000,
  activate: 30_000,
  program: 5000,
  manual: 0,
  // The shell's prompt names another branch than the last query did, so that answer is out of date.
  branch: 0,
};

type Deps = {
  /** Null means the answer no longer applies, such as after a reconnect. Throws on failure. */
  query(folder: string): Promise<GitResult | null>;
  /** Automatic queries are on and the connection is up. */
  auto(): boolean;
  now(): number;
  later(run: () => void, ms: number): () => void;
  changed(): void;
  /** A manual query that could not finish, as the text to show. */
  failed(error: unknown): string;
};

/**
 * One spelling per folder. A Windows shell reports `C:\repo`, the local file panel joins children
 * as `C:\repo/src`, and Git prints `C:/repo`. A POSIX path is kept as is, since a backslash is an
 * ordinary file name character there.
 */
export function gitPath(path: string) {
  if (!/^([A-Za-z]:|[\\/]{2})/.test(path)) return path;
  return path.replace(/\\/g, '/').replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

const inside = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

/**
 * One query at a time per connection, and one waiting, which the latest request replaces. There
 * is no timer polling: an event too soon after the last query of its folder either waits out the
 * rest of the interval once, or for a tab switch, is dropped because the result is recent.
 */
export class GitScheduler {
  private folders = new Map<string, GitResult>();
  private repos = new Map<string, GitRepo>();
  private last = new Map<string, number>();
  private stopped = new Set<string>();
  private timers = new Map<string, () => void>();
  private running = false;
  private queued: { folder: string; manual: boolean } | null = null;
  /** The first line of the last manual query's failure. */
  error = '';
  constructor(private readonly deps: Deps) {}
  private isStopped(folder: string) {
    const known = this.folders.get(folder);
    return (
      this.stopped.has(folder) ||
      (known?.kind === 'repo' && this.stopped.has(known.root)) ||
      [...this.stopped].some((root) => this.repos.has(root) && inside(folder, root))
    );
  }
  request(event: GitEvent, folder: string | null | undefined) {
    if (!folder) return;
    const manual = event === 'manual';
    if (!manual && (!this.deps.auto() || this.isStopped(folder))) return;
    const wait = (this.last.get(folder) ?? -Infinity) + minInterval[event] - this.deps.now();
    if (wait > 0) {
      if (event === 'activate' || this.timers.has(folder)) return;
      const cancel = this.deps.later(() => {
        this.timers.delete(folder);
        if (this.deps.auto() && !this.isStopped(folder)) this.enqueue(folder, false);
      }, wait);
      this.timers.set(folder, cancel);
      return;
    }
    this.enqueue(folder, manual);
  }
  private enqueue(folder: string, manual: boolean) {
    if (this.running) {
      const keep = this.queued?.folder === folder && this.queued.manual;
      this.queued = { folder, manual: manual || keep };
      return;
    }
    void this.run(folder, manual);
  }
  private async run(folder: string, manual: boolean) {
    this.running = true;
    this.last.set(folder, this.deps.now());
    try {
      const result = await this.deps.query(folder);
      if (result) this.apply(folder, result, manual);
    } catch (error) {
      // A refused channel (such as MaxSessions) waits for the next event.
      if (manual) this.error = this.deps.failed(error);
    } finally {
      this.running = false;
      this.deps.changed();
      const next = this.queued;
      this.queued = null;
      if (next) this.enqueue(next.folder, next.manual);
    }
  }
  private apply(folder: string, result: GitResult, manual: boolean) {
    const before = this.folders.get(folder);
    this.folders.set(folder, result);
    if (result.kind === 'repo') {
      this.repos.set(result.root, result);
      this.stopped.delete(folder);
      this.stopped.delete(result.root);
      if (manual) this.error = '';
      return;
    }
    if (result.kind === 'stopped') {
      this.stopped.add(folder);
      if (before?.kind === 'repo') this.stopped.add(before.root);
      if (manual) this.error = '';
      return;
    }
    // Not a repository: quiet, except when the user asked.
    if (manual) this.error = result.detail || 'Git 저장소가 아닙니다.';
  }
  /** What a folder shows: its repository, also when only a parent folder was asked about. */
  view(folder: string | null | undefined): GitView {
    if (!folder) return null;
    const known = this.folders.get(folder);
    if (known?.kind === 'stopped') return { stopped: known.reason };
    if (known?.kind === 'notRepo') return null;
    const root =
      known?.kind === 'repo'
        ? known.root
        : [...this.repos.keys()]
            .filter((r) => inside(folder, r))
            .sort((a, b) => b.length - a.length)[0];
    const repo = root && this.repos.get(root);
    return repo ? { repo } : null;
  }
  /** A new connection: earlier answers describe another shell. */
  clear() {
    this.timers.forEach((cancel) => cancel());
    this.timers.clear();
    this.folders.clear();
    this.repos.clear();
    this.last.clear();
    this.stopped.clear();
    this.queued = null;
    this.error = '';
  }
}

export const branchLabel = (repo: GitRepo) =>
  repo.branch ?? `(${repo.oid ? repo.oid.slice(0, 7) : '분리됨'})`;

/** A query's branch in the shell hook's spelling: a name, `@` and 7 hex digits, or nothing. */
export const hookBranch = (repo: GitRepo) =>
  repo.branch ?? (repo.oid ? `@${repo.oid.slice(0, 7)}` : '');

export const changeCount = (repo: GitRepo) => `${repo.entries.length}${repo.truncated ? '+' : ''}`;

/** Commits ahead of and behind the upstream, such as `↑1 ↓2`, or nothing when in step. */
export const syncText = (repo: Pick<GitRepo, 'ahead' | 'behind'>) =>
  [repo.ahead ? `↑${repo.ahead}` : '', repo.behind ? `↓${repo.behind}` : '']
    .filter(Boolean)
    .join(' ');

/** The short status bar text, such as `main ●3`, with as much as the setting asks for. */
export function gitStatusText(repo: GitRepo, detail: GitDisplay['detail'] = 'changes') {
  const parts = [branchLabel(repo)];
  if (detail !== 'branch' && repo.entries.length) parts.push(`●${changeCount(repo)}`);
  if (detail === 'sync' && syncText(repo)) parts.push(syncText(repo));
  return parts.join(' ');
}

/** A whole sentence for screen readers and tab tooltips. */
export const gitSentence = (repo: GitRepo) =>
  `Git ${branchLabel(repo)}, ${repo.entries.length ? `변경 ${changeCount(repo)}개` : '변경 없음'}`;

export function gitTooltip(repo: GitRepo) {
  const upstream = repo.upstream
    ? `${repo.upstream} 대비 앞섬 ${repo.ahead} · 뒤처짐 ${repo.behind}`
    : '업스트림 없음';
  const counts = (['M', 'A', 'D', '?', 'U'] as const)
    .map((mark) => [mark, repo.entries.filter((e) => e.mark === mark).length] as const)
    .filter(([, n]) => n)
    .map(([mark, n]) => `${fileMarkLabels[mark]} ${n}`)
    .join(' · ');
  return [
    `저장소 ${repo.root}`,
    `브랜치 ${branchLabel(repo)} · ${upstream}`,
    repo.entries.length
      ? `변경 ${changeCount(repo)}개${counts ? ` (${counts})` : ''}${repo.truncated ? ' · 많음' : ''}`
      : '변경 없음',
  ].join('\n');
}

/** File tree marks: a letter for a changed path, and `folder` for a folder with changes inside. */
export function treeMarks(repo: GitRepo) {
  const marks = new Map<string, FileMark>();
  const root = repo.root.replace(/\/+$/, '');
  for (const entry of repo.entries) {
    const path = `${root}/${entry.path.replace(/\/$/, '')}`;
    marks.set(path, entry.mark);
    for (let at = path.lastIndexOf('/'); at > root.length; at = path.lastIndexOf('/', at - 1)) {
      const folder = path.slice(0, at);
      if (marks.has(folder)) break;
      marks.set(folder, 'folder');
    }
  }
  return marks;
}
