import { useEffect, useSyncExternalStore } from 'react';
import { call, errorText } from '../../lib/ipc';
import { terminalPreferences } from '../terminal/preferences';
import type { TerminalSession } from '../terminal/session';
import { sessionKind, sessionSource } from '../terminal/sessionKind';
import { GitScheduler, gitPath, type GitEvent, type GitResult } from './gitStatus';
import { gitStatusOf, useGitStatus } from './useGitStatus';
import type { GitViewRepo, GitViewResult } from './gitViewModel';

/** What the scheduler needs to know of a reply: it only decides when to ask again. */
function forScheduler(result: GitViewResult): GitResult {
  if (result.kind === 'repo') return { ...result, entries: [] };
  if (result.kind === 'noGit') return { kind: 'notRepo', detail: result.detail };
  return result;
}

/**
 * The sidebar Git view's listing of one tab. It has a scheduler of its own because this query asks
 * for every untracked file, which the status bar's does not, and runs only while the view is open.
 */
class GitViewStore {
  private listeners = new Set<() => void>();
  private version = 0;
  private results = new Map<string, GitViewResult>();
  private repos = new Map<string, GitViewRepo>();
  readonly scheduler: GitScheduler;
  constructor(private readonly session: TerminalSession) {
    this.scheduler = new GitScheduler({
      query: async (folder) => {
        const source = sessionSource(session);
        if (!source) return null;
        const id = session.connectionId;
        const result = await call<GitViewResult>('git_view', { source, folder });
        if (id !== session.connectionId) return null;
        this.results.set(folder, result);
        if (result.kind === 'repo') this.repos.set(result.root, result);
        this.scheduler.error = '';
        return forScheduler(result);
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
    let connection = session.connectionId;
    session.subscribe(() => {
      if (session.connectionId === connection) return;
      connection = session.connectionId;
      this.scheduler.clear();
      this.results.clear();
      this.repos.clear();
      this.changed();
    });
  }
  private get connected() {
    return this.session.snapshot().status === 'connected';
  }
  private changed() {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }
  request(event: GitEvent, folder: string) {
    if (event === 'manual' && !this.connected) return;
    this.scheduler.request(event, folder);
  }
  /** The last reply for a folder, or the repository a parent's reply already found. */
  result(folder: string): GitViewResult | null {
    const direct = this.results.get(folder);
    if (direct) return direct;
    const known = this.scheduler.view(folder);
    return (known && 'repo' in known && this.repos.get(known.repo.root)) || null;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
}

const stores = new WeakMap<TerminalSession, GitViewStore>();

function storeOf(session: TerminalSession) {
  let store = stores.get(session);
  if (!store) stores.set(session, (store = new GitViewStore(session)));
  return store;
}

export type GitViewModel =
  | { state: 'noTab' }
  | { state: 'unsupported'; ftp: boolean }
  | { state: 'disconnected' }
  | { state: 'noFolder' }
  | {
      state: 'ready';
      result: GitViewResult | null;
      error: string;
      folder: string;
      /** A server or WSL distribution, as opposed to this PC. */
      remote: boolean;
      refresh: () => void;
    };

const noStore = { subscribe: () => () => {}, snapshot: () => 0 };
const noSession = { subscribe: () => () => {}, snapshot: () => undefined };

/**
 * What the sidebar shows for a tab. It follows the status bar's query, so every event that query
 * already reacts to (folder, prompt, program state, tab switch) refreshes the list too.
 */
export function useGitView(session: TerminalSession | undefined): GitViewModel {
  const status = gitStatusOf(session);
  const store = status && session ? storeOf(session) : null;
  useSyncExternalStore((status ?? noStore).subscribe, (status ?? noStore).snapshot);
  useSyncExternalStore((store ?? noStore).subscribe, (store ?? noStore).snapshot);
  const connected = useSyncExternalStore(
    session?.subscribe ?? noSession.subscribe,
    () => session?.snapshot().status === 'connected',
  );
  const directory = useGitStatus(session)?.directory;
  const tree = status?.treeFolder;
  const folder = directory || (tree && gitPath(tree)) || null;

  useEffect(() => {
    if (store && folder && connected) store.request('manual', folder);
  }, [store, folder, connected]);
  useEffect(() => {
    if (!store || !status || !folder) return;
    return status.subscribe(() => store.request('refresh', folder));
  }, [store, status, folder]);

  if (!session) return { state: 'noTab' };
  if (!store || !status) return { state: 'unsupported', ftp: sessionKind(session) === 'ftp' };
  if (!connected) return { state: 'disconnected' };
  if (!folder) return { state: 'noFolder' };
  return {
    state: 'ready',
    result: store.result(folder),
    error: store.scheduler.error,
    folder,
    remote: !session.localTarget,
    refresh: () => {
      store.request('manual', folder);
      status.request('manual', folder);
    },
  };
}
