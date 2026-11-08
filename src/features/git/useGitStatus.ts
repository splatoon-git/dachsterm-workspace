import { useMemo, useSyncExternalStore } from 'react';
import { call, errorText } from '../../lib/ipc';
import { commandMarksOf } from '../terminal/commandMarks';
import { terminalPreferences, useTerminalPreferences } from '../terminal/preferences';
import type { TerminalSession } from '../terminal/session';
import { sessionKind } from '../terminal/sessionKind';
import {
  GitScheduler,
  gitPath,
  hookBranch,
  treeMarks,
  type GitEvent,
  type GitResult,
} from './gitStatus';

/**
 * The Git status of one SSH, local or WSL tab. It listens to what the tab already reports (folder
 * changes, prompts, program states) and the views report tab switches and file tree refreshes.
 */
class GitStatusStore {
  private listeners = new Set<() => void>();
  private version = 0;
  readonly scheduler: GitScheduler;
  constructor(private readonly session: TerminalSession) {
    this.scheduler = new GitScheduler({
      query: async (folder) => {
        const id = session.connectionId;
        const target = session.localTarget;
        const askedAt = Date.now();
        const result = await (target
          ? call<GitResult>('local_git_status', { targetId: target.id, folder })
          : call<GitResult>('git_status', { id, folder }));
        if (id !== session.connectionId) return null;
        this.askedAt.set(folder, askedAt);
        return result;
      },
      auto: () => terminalPreferences().gitStatus && this.connected,
      now: () => Date.now(),
      later: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
      changed: () => this.changed(),
      failed: errorText,
    });
    let { directory, status } = session.snapshot();
    let connection = session.connectionId;
    session.subscribe(() => {
      const now = session.snapshot();
      if (session.connectionId !== connection) {
        connection = session.connectionId;
        this.scheduler.clear();
        this.askedAt.clear();
        this.changed();
      }
      if (now.status === 'connected' && (now.directory !== directory || status !== 'connected'))
        this.request('folder', now.directory);
      ({ directory, status } = now);
    });
    let program = session.programStatus.snapshot()?.state;
    session.programStatus.subscribe(() => {
      const state = session.programStatus.snapshot()?.state;
      if (state !== program && (state === 'done' || state === 'blocked'))
        this.request('program', this.directory);
      program = state;
    });
    // A prompt drawn again from old output says nothing about the folder now.
    const marks = commandMarksOf(session.terminal);
    marks?.onPrompt((replaying) => {
      if (!replaying) this.request('prompt', this.directory);
    });
    marks?.onBranch((branch) => this.branchReported(branch));
  }
  /** When the answer each folder has now was asked for. */
  private askedAt = new Map<string, number>();
  /** The last report that asked again, so a shell Git never agrees with asks only once. */
  private askedFor = '';
  /** The prompt names another branch than the last query, which is then out of date. */
  private branchReported(branch: string) {
    const folder = this.directory;
    if (!folder) return;
    const view = this.scheduler.view(folder);
    const queried = view && 'repo' in view ? hookBranch(view.repo) : '';
    const report = `${folder}\n${branch}`;
    if (branch === queried) this.askedFor = '';
    else if (report !== this.askedFor) {
      this.askedFor = report;
      this.request('branch', folder);
    }
  }
  private get connected() {
    return this.session.snapshot().status === 'connected';
  }
  get directory() {
    const folder = this.session.snapshot().directory;
    return folder && gitPath(folder);
  }
  /** The folder the sidebar's file tree lists. */
  treeFolder: string | null = null;
  listed = (listing: string) => {
    const folder = gitPath(listing);
    if (folder !== this.treeFolder) {
      this.treeFolder = folder;
      this.changed();
    }
    this.request('refresh', folder);
  };
  request(event: GitEvent, folder = this.directory) {
    if (event === 'manual' && !this.connected) return;
    this.scheduler.request(event, folder && gitPath(folder));
  }
  private changed() {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
  /** When the folder's current answer was asked for, or 0 when it has none. */
  answerTime = (folder: string) => this.askedAt.get(folder) ?? 0;
}

const stores = new WeakMap<TerminalSession, GitStatusStore>();

/** Tabs with a shell folder. FTP and PodTree have none. */
export function gitStatusOf(session: TerminalSession | undefined) {
  const kind = session && sessionKind(session);
  if (!session || (kind !== 'ssh' && kind !== 'local')) return null;
  let store = stores.get(session);
  if (!store) stores.set(session, (store = new GitStatusStore(session)));
  return store;
}

const noStore = { subscribe: () => () => {}, snapshot: () => 0 };
const noSession = { subscribe: () => () => {}, snapshot: () => undefined };

/** The status of the folder the tab's shell is in. */
export function useGitStatus(session: TerminalSession | undefined) {
  const store = gitStatusOf(session);
  useSyncExternalStore((store ?? noStore).subscribe, (store ?? noStore).snapshot);
  const reported = useSyncExternalStore(
    session?.subscribe ?? noSession.subscribe,
    () => session?.snapshot().directory,
  );
  const directory = reported && gitPath(reported);
  const { gitStatus: auto } = useTerminalPreferences();
  if (!store) return null;
  return {
    view: store.scheduler.view(directory),
    error: store.scheduler.error,
    /** The folder is known, so a manual query is possible. */
    directory,
    auto,
    answerTime: directory ? store.answerTime(directory) : 0,
    refresh: () => store.request('manual', directory),
  };
}

/** File tree marks for the folder the sidebar lists, and the event of listing it again. */
export function useGitFileMarks(session: TerminalSession | undefined) {
  const store = gitStatusOf(session);
  useSyncExternalStore((store ?? noStore).subscribe, (store ?? noStore).snapshot);
  const view = store?.treeFolder ? store.scheduler.view(store.treeFolder) : null;
  const repo = view && 'repo' in view ? view.repo : null;
  const marks = useMemo(() => (repo ? treeMarks(repo) : null), [repo]);
  const listed = store?.listed;
  return useMemo(
    () => (listed ? { mark: (path: string) => marks?.get(gitPath(path)), listed } : null),
    [listed, marks],
  );
}
