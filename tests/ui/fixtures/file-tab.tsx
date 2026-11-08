// Isolated UI fixture: the real file row, workspace and file tab, with `file_read` answered here.
// This is not part of the production entry point and reads no real file.
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { FileOpenContext } from '../../../src/components/fileOpen';
import type { FileRead } from '../../../src/features/editor/fileRead';
import type { GitFileDiff } from '../../../src/features/editor/gitFileDiff';
import type { GitRow } from '../../../src/features/git/gitViewModel';
import { notifyGitChange } from '../../../src/lib/gitChanges';
import type { LocalTarget, TerminalSession } from '../../../src/features/terminal/session';
import type { Source } from '../../../src/lib/source';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

type Answer = FileRead | { fail: string };
type WriteAnswer =
  | { status: 'saved'; hash: string; notice: string | null }
  | { status: 'conflict'; hash: string | null }
  | { fail: string };

declare global {
  interface Window {
    __fileTab: {
      /** By path, or `path|large` and `path|<encoding>` for a read with that option. */
      files: Record<string, Answer>;
      status: 'connected' | 'closed';
      calls: { path: string; options: { large: boolean; encoding: string | null } }[];
      opened: string[];
      /** The folders whose rows asked to open or close. */
      toggled?: string[];
      /** Every `file_write`, in order. */
      writes: { path: string; content: string; encoding: string; baseHash: string | null }[];
      /** Answers for the next writes; after these, each write saves as `saved-N`. */
      answers: WriteAnswer[];
      /** `confirmWindowClose`, what closing the window asks. */
      closeWindow?: () => Promise<boolean>;
      /** By `<compare kind>:<path>`. */
      diffs?: Record<string, GitFileDiff | { fail: string }>;
      diffCalls?: Record<string, unknown>[];
      openDiff?: (row: GitRow, pinned: boolean) => void;
      /** What the Git view tells open tabs after it changed the repository. */
      notifyIndex?: () => void;
      /** No terminal tab at all, and the real tools menu with the start page beside it. */
      noSession?: boolean;
      /** Answers for the next `local_file_pick`; null is a closed picker. */
      picks?: (string | null | { fail: string })[];
      targets?: LocalTarget[];
      /** The `source` of every `file_read` and `file_write`. */
      sources?: Source[];
      /** What `fail` was told. */
      failures?: string[];
    };
    __pwned?: boolean;
    __fileTabEnd?: () => void;
  }
}

const state = window.__fileTab;
state.calls = [];
state.opened = [];
state.writes = [];
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (command: string, args: Record<string, unknown>) => {
      if (command === 'url_open') {
        state.opened.push(args.url as string);
        return null;
      }
      if (command === 'local_file_pick') {
        const pick = state.picks?.shift();
        if (pick === undefined) throw 'unexpected file picker';
        if (typeof pick === 'object' && pick) throw pick.fail;
        return pick;
      }
      if (command === 'local_targets') return { targets: state.targets ?? [], warning: null };
      if (command === 'file_read' || command === 'file_write')
        state.sources?.push(args.source as Source);
      if (command === 'file_write') {
        const write = args as Window['__fileTab']['writes'][number];
        state.writes.push(write);
        const answer = state.answers.shift() ?? {
          status: 'saved' as const,
          hash: `saved-${state.writes.length}`,
          notice: null,
        };
        if ('fail' in answer) throw answer.fail;
        return answer;
      }
      if (command === 'git_file_diff') {
        state.diffCalls?.push(args);
        const answer = state.diffs?.[`${(args.compare as { kind: string }).kind}:${args.path}`];
        if (!answer) throw `unexpected diff of ${args.path}`;
        if ('fail' in answer) throw answer.fail;
        return structuredClone(answer);
      }
      if (command !== 'file_read') throw `unexpected ${command}`;
      const path = args.path as string;
      const options = args.options as Window['__fileTab']['calls'][number]['options'];
      state.calls.push({ path, options });
      const answer =
        (options.large && state.files[`${path}|large`]) ||
        (options.encoding && state.files[`${path}|${options.encoding}`]) ||
        state.files[path];
      if ('fail' in answer) throw answer.fail;
      return structuredClone(answer);
    },
  },
});

// A stand-in for the part of a terminal session the file tabs read. Like the real one, its
// snapshot is the same object until something changes.
let snapshot = { status: state.status };
const sessionListeners = new Set<() => void>();
const session = {
  tabId: 't1',
  connectionId: 'c1',
  profile: { protocol: 'ssh', name: '서버' },
  subscribe: (listener: () => void) => {
    sessionListeners.add(listener);
    return () => sessionListeners.delete(listener);
  },
  snapshot: () => snapshot,
} as unknown as TerminalSession;
window.__fileTabEnd = () => {
  snapshot = { status: 'closed' };
  sessionListeners.forEach((listener) => listener());
};

// Loaded after the stub, since `desktop` is read when the IPC module loads.
const [{ useWorkspaceLayout }, { useFileTabs }, { WorkspaceGrid }, { PlainTab }, { FileTreeRow }] =
  await Promise.all([
    import('../../../src/app/useWorkspaceLayout'),
    import('../../../src/app/useFileTabs'),
    import('../../../src/app/WorkspaceGrid'),
    import('../../../src/app/GroupTabBar'),
    import('../../../src/features/sftp/fileTree'),
  ]);
const { tabKey } = await import('../../../src/app/workspaceLayout');
const { HeaderMenus } = await import('../../../src/app/HeaderTools');
const noSession = !!state.noSession;
const noop = () => {};

state.notifyIndex = () =>
  notifyGitChange({
    kind: 'index',
    source: { kind: 'ssh', connectionId: 'c1' },
    root: '/srv/app',
  });

function Harness() {
  const workspace = useWorkspaceLayout();
  const { open: openTab } = workspace;
  const files = useFileTabs({
    workspace,
    sessions: noSession ? [] : [session],
    narrow: false,
    fail: (message) => (state.failures ??= []).push(message),
  });
  useEffect(() => {
    if (!noSession) openTab({ kind: 'session', tabId: 't1' });
  }, [openTab]);
  useEffect(() => {
    state.closeWindow = files.confirmWindowClose;
    state.openDiff = (row, pinned) => files.openDiff(session, row, '/srv/app', pinned);
  });
  const focusedKey = workspace.focusedGroup.active;
  const focusedTab = workspace.focusedGroup.tabs.find((tab) => tabKey(tab) === focusedKey);
  const row = (path: string) => ({
    name: path.slice(1),
    label: path.slice(1),
    path,
    directory: path.endsWith('/'),
    symlink: path.endsWith('.link'),
    size: 1,
    modified: null,
    permissions: null,
    depth: 0,
    expanded: false,
  });
  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <div style={{ width: 200 }} aria-label="파일 목록">
        {noSession && (
          <HeaderMenus
            sidebarOpen={false}
            toggleSidebar={noop}
            tools={{ tunnels: noop, editor: files.pickDocument }}
            activeGame={null}
            openGame={noop}
            preview={noop}
          />
        )}
        <FileOpenContext.Provider value={(path, pinned) => files.open(session, path, pinned)}>
          {Object.keys(state.files)
            .filter((path) => !path.includes('|'))
            .map((path) => (
              <FileTreeRow
                key={path}
                row={row(path)}
                selected={false}
                toggle={() => (state.toggled ??= []).push(path)}
                onDoubleClick={() => document.body.setAttribute('data-panel-open', path)}
              />
            ))}
        </FileOpenContext.Provider>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <WorkspaceGrid
          workspace={workspace}
          narrow={false}
          order={[
            ...(noSession ? [] : [{ kind: 'session', tabId: 't1' } as const]),
            ...files.order,
          ]}
          detach={() => {}}
          start={
            noSession
              ? {
                  tab: (active, select) => (
                    <PlainTab title="시작하기" active={active} select={select} />
                  ),
                  page: <p>시작 화면</p>,
                }
              : undefined
          }
          renderTab={(tab, group) => {
            const key = tabKey(tab);
            const active = group.active === key;
            const select = () => workspace.select(group.id, key);
            return tab.kind === 'file' || tab.kind === 'diff' ? (
              files.renderTab(tab, active, select)
            ) : (
              <PlainTab tabKey={key} title="터미널" active={active} select={select} />
            );
          }}
          renderCell={(tab) =>
            tab.kind === 'file' || tab.kind === 'diff' ? files.renderCell(tab) : <p>터미널 화면</p>
          }
        />
      </div>
      <footer aria-label="상태바" style={{ position: 'fixed', right: 0, bottom: 0, zIndex: 100 }}>
        {files.status(focusedTab)}
      </footer>
      {files.dialog}
    </div>
  );
}

applyTheme(getCurrentTheme());
createRoot(document.getElementById('root')!).render(<Harness />);
