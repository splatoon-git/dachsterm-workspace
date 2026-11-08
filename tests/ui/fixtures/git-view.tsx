// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { createRoot } from 'react-dom/client';
import type { CommitDetail, GitGraphResult } from '../../../src/features/git/commitGraphModel';
import type { GitRow, GitViewResult } from '../../../src/features/git/gitViewModel';
import type { GitApplyResult } from '../../../src/features/git/gitWrite';
import type { TerminalSession } from '../../../src/features/terminal/session';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

declare global {
  interface Window {
    __gitView: {
      result: GitViewResult;
      graph: GitGraphResult;
      /** A commit's detail, or a message to fail with. */
      detail: CommitDetail | string;
      tab: 'ssh' | 'local' | 'ftp' | 'none';
      status: 'connected' | 'closed';
      directory: string | null;
      reviewable: boolean;
      reviewed: number;
      calls: { command: string; args: Record<string, unknown> }[];
      /** What `git_apply` answers, when it is not simply done. */
      applyResult?: GitApplyResult;
      /** The terminal's screen: `alternate` while a full-screen program runs. */
      buffer: 'normal' | 'alternate';
      /** What the view typed in the terminal. */
      sent: string[];
      /** The tabs the view asked for: `file:<path>` or `diff:<group>:<path>`, then if pinned. */
      opens: [string, boolean][];
    };
    /** The tab drops its connection and comes back with a new connection ID. */
    __gitReconnect: () => void;
  }
}

const state = window.__gitView;
state.calls = [];
state.reviewed = 0;
state.sent = [];
state.opens = [];
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (command: string, args: Record<string, unknown>) => {
      state.calls.push({ command, args });
      if (command === 'git_view') return structuredClone(state.result);
      if (command === 'git_status') return { kind: 'notRepo', detail: '' };
      if (command === 'git_graph') return structuredClone(state.graph);
      if (command === 'git_commit_detail') {
        if (typeof state.detail === 'string') throw state.detail;
        return structuredClone(state.detail);
      }
      if (
        ['clipboard_write_text', 'files_reveal', 'local_files_edit', 'edit_start'].includes(command)
      )
        return null;
      if (command === 'git_apply')
        return state.applyResult ?? { kind: 'done', commands: ['git add -A'] };
      if (command === 'git_refs')
        return {
          root: '/srv/app',
          worktrees: [],
          refs: ['refs/heads/main', 'refs/heads/feat', 'refs/remotes/origin/only-remote'],
          truncated: false,
        };
      throw `unexpected ${command}`;
    },
  },
});

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

// A stand-in for the part of a terminal session the view reads.
const session = {
  connectionId: 'c1',
  profile: { protocol: state.tab === 'ftp' ? 'ftp' : 'ssh', name: '서버' },
  localTarget: state.tab === 'local' ? { id: 'wsl:U', kind: 'wsl' } : undefined,
  terminal: { focus: () => {}, buffer: { active: { type: state.buffer } } },
  send: (data: string) => state.sent.push(data),
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  snapshot: () => ({ status: state.status, directory: state.directory }),
  programStatus: { subscribe: () => () => {}, snapshot: () => undefined },
} as unknown as TerminalSession;

window.__gitReconnect = () => {
  state.status = 'closed';
  notify();
  setTimeout(() => {
    (session as unknown as { connectionId: string }).connectionId = 'c2';
    state.status = 'connected';
    notify();
  }, 50);
};

// Loaded after the stub, since `desktop` is read when the IPC module loads.
const { GitView } = await import('../../../src/features/git/GitView');
applyTheme(getCurrentTheme());
createRoot(document.getElementById('root')!).render(
  <div className="workspace-sidebar" style={{ width: 300, height: 480, display: 'flex' }}>
    <div className="sidebar-file-panel">
      <GitView
        session={state.tab === 'none' ? undefined : session}
        review={state.reviewable ? () => (state.reviewed += 1) : undefined}
        openFile={(path, pinned) => state.opens.push([`file:${path}`, pinned])}
        openDiff={(row: GitRow, _root, pinned) =>
          state.opens.push([`diff:${row.group}:${row.path}`, pinned])
        }
      />
    </div>
  </div>,
);
