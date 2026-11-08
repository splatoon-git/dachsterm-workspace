// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { createRoot } from 'react-dom/client';
import type { GitViewResult } from '../../../src/features/git/gitViewModel';
import type { TerminalSession } from '../../../src/features/terminal/session';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

declare global {
  interface Window {
    __gitView: {
      result: GitViewResult;
      tab: 'ssh' | 'local' | 'ftp' | 'none';
      status: 'connected' | 'closed';
      directory: string | null;
      reviewable: boolean;
      reviewed: number;
      calls: { command: string; args: Record<string, unknown> }[];
    };
  }
}

const state = window.__gitView;
state.calls = [];
state.reviewed = 0;
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (command: string, args: Record<string, unknown>) => {
      state.calls.push({ command, args });
      if (command === 'git_view') return structuredClone(state.result);
      if (command === 'git_status') return { kind: 'notRepo', detail: '' };
      if (command === 'clipboard_write_text') return null;
      throw `unexpected ${command}`;
    },
  },
});

// A stand-in for the part of a terminal session the view reads.
const session = {
  connectionId: 'c1',
  profile: { protocol: state.tab === 'ftp' ? 'ftp' : 'ssh', name: '서버' },
  localTarget: state.tab === 'local' ? { id: 'wsl:U', kind: 'wsl' } : undefined,
  terminal: {},
  subscribe: () => () => {},
  snapshot: () => ({ status: state.status, directory: state.directory }),
  programStatus: { subscribe: () => () => {}, snapshot: () => undefined },
} as unknown as TerminalSession;

// Loaded after the stub, since `desktop` is read when the IPC module loads.
const { GitView } = await import('../../../src/features/git/GitView');
applyTheme(getCurrentTheme());
createRoot(document.getElementById('root')!).render(
  <div className="workspace-sidebar" style={{ width: 300, height: 480, display: 'flex' }}>
    <div className="sidebar-file-panel">
      <GitView
        session={state.tab === 'none' ? undefined : session}
        review={state.reviewable ? () => (state.reviewed += 1) : undefined}
      />
    </div>
  </div>,
);
