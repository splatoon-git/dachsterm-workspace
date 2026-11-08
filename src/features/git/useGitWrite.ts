import { useRef, useState, useSyncExternalStore } from 'react';
import { call, errorText } from '../../lib/ipc';
import type { TerminalSession } from '../terminal/session';
import { sessionSource } from '../terminal/sessionKind';
import { readinessOf, typeInTerminal } from './gitTerminal';
import {
  failureText,
  type GitAction,
  type GitApplyResult,
  type GitDialogRequest,
  type GitLogEntry,
} from './gitWrite';
import type { GitViewRepo } from './gitViewModel';

const maxLog = 50;

/** One tab's commit message and output list. The view is unmounted while another one is open. */
class GitWriteStore {
  draft = '';
  log: GitLogEntry[] = [];
  private nextId = 1;
  private listeners = new Set<() => void>();
  private version = 0;
  private changed() {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }
  setDraft = (draft: string) => {
    this.draft = draft;
    this.changed();
  };
  add(entries: Omit<GitLogEntry, 'id'>[]) {
    const fresh = entries.map((entry) => ({ ...entry, id: this.nextId++ })).reverse();
    this.log = [...fresh, ...this.log].slice(0, maxLog);
    this.changed();
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
}

const stores = new WeakMap<TerminalSession, GitWriteStore>();
function storeOf(session: TerminalSession) {
  let store = stores.get(session);
  if (!store) stores.set(session, (store = new GitWriteStore()));
  return store;
}
const noStore = { subscribe: () => () => {}, snapshot: () => 0 };

function logEntries(result: GitApplyResult): Omit<GitLogEntry, 'id'>[] {
  const last = result.commands.length - 1;
  return result.commands.map((command, index) => {
    const failed = result.kind === 'failed' && index === last;
    return {
      command,
      where: 'app',
      result: failed ? 'failed' : 'done',
      detail: failed ? failureText(result) : '',
    };
  });
}

/** The Git view's write actions: one at a time, each followed by a new listing. */
export function useGitWrite({
  session,
  repo,
  refresh,
  notice,
  ask,
}: {
  session: TerminalSession | undefined;
  repo: GitViewRepo | null;
  refresh: () => void;
  notice: (text: string) => void;
  ask: (request: GitDialogRequest) => void;
}) {
  const store = session ? storeOf(session) : null;
  useSyncExternalStore((store ?? noStore).subscribe, (store ?? noStore).snapshot);
  const [busy, setBusy] = useState(false);
  /** The last commit failed for want of an author, which the Git settings can give. */
  const [identityMissing, setIdentityMissing] = useState(false);
  const running = useRef(false);
  const source = session ? sessionSource(session) : null;

  const apply = async (action: GitAction) => {
    if (!session || !store || !repo || !source || running.current) return false;
    running.current = true;
    setBusy(true);
    notice('');
    setIdentityMissing(false);
    const id = session.connectionId;
    try {
      const result = await call<GitApplyResult>('git_apply', { source, root: repo.root, action });
      if (id !== session.connectionId) return false;
      store.add(logEntries(result));
      if (result.kind === 'done') return true;
      notice(failureText(result));
      setIdentityMissing(result.reason === 'identity');
      return false;
    } catch (e) {
      notice(errorText(e));
      return false;
    } finally {
      running.current = false;
      setBusy(false);
      refresh();
    }
  };

  /** Types a line the user has seen or asked for, without looking at the terminal again. */
  const typeCommand = (command: string) => {
    if (!session || !store) return;
    notice('');
    setIdentityMissing(false);
    store.add([{ command, where: 'terminal', result: 'typed', detail: '' }]);
    typeInTerminal(session, command);
  };

  const runInTerminal = async (command: string) => {
    if (!session || !repo) return;
    setIdentityMissing(false);
    const readiness = await readinessOf(session, repo.root);
    if (readiness.state === 'blocked') notice(readiness.text);
    else if (readiness.state === 'ask') ask({ kind: 'terminal', command });
    else typeCommand(command);
  };

  return {
    busy,
    identityMissing,
    source,
    draft: store?.draft ?? '',
    setDraft: store?.setDraft ?? (() => {}),
    log: store?.log ?? [],
    apply,
    runInTerminal,
    typeCommand,
    note: notice,
  };
}

export type GitWrite = ReturnType<typeof useGitWrite>;
