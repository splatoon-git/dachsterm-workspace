// Isolated UI fixture: the real status bar with `git_status` answered here.
// This is not part of the production entry point or an SSH test.
import { createRoot } from 'react-dom/client';
import type { GitResult } from '../../../src/features/git/gitStatus';
import type { TerminalSession } from '../../../src/features/terminal/session';
import { PaneView } from '../../../src/features/terminal/paneView';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';
import '../../../src/features/editor/fileTab.css';

declare global {
  interface Window {
    __statusBar: {
      git: GitResult;
      /** A detached window has no Git view to open. */
      detached: boolean;
      file: boolean;
      queries: number;
      opened: number;
    };
    /** The shell moved to this folder. */
    __cd: (directory: string) => void;
  }
}

const state = window.__statusBar;
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (command: string) => {
      if (command === 'git_status') {
        state.queries++;
        return structuredClone(state.git);
      }
      if (command === 'log_status') return { state: 'off' };
      if (command === 'monitor_configure') return null;
      if (command === 'monitor_get')
        return {
          connectionId: 'c1',
          enabled: true,
          interval: 5,
          interface: 'all',
          status: 'ok',
          message: '측정 중',
          history: [
            {
              at: Date.now(),
              cpu: 12.5,
              memoryTotal: 100,
              memoryUsed: 40,
              rx: 2048,
              tx: 1024,
              load: '0.1',
              disks: [{ mount: '/', total: 100, used: 50, available: 50 }],
              interfaces: ['eth0'],
            },
          ],
        };
      throw `unexpected ${command}`;
    },
  },
});

const listeners = new Set<() => void>();
let snapshot = { status: 'connected', directory: null as string | null };
window.__cd = (directory) => {
  snapshot = { ...snapshot, directory };
  listeners.forEach((listener) => listener());
};

// A stand-in for the part of a terminal session the status bar reads.
const session = {
  tabId: 't1',
  connectionId: 'c1',
  profile: { protocol: 'ssh', name: '서버', username: 'u', host: 'srv', port: 22 },
  view: new PaneView(),
  terminal: {
    buffer: { active: { type: 'normal' }, onBufferChange: () => ({ dispose: () => {} }) },
  },
  programStatus: { subscribe: () => () => {}, snapshot: () => undefined },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  snapshot: () => snapshot,
} as unknown as TerminalSession;

// Loaded after the stub, since `desktop` is read when the IPC module loads.
const [{ StatusBar }, { FileStatusItems }, { setFileStatus }] = await Promise.all([
  import('../../../src/app/StatusBar'),
  import('../../../src/features/editor/FileStatusItems'),
  import('../../../src/features/editor/fileStatus'),
]);

if (state.file)
  setFileStatus('f1', {
    eol: 'CRLF',
    indent: '공백 2',
    encoding: 'utf-8',
    language: 'typescript',
    chooseEncoding: () => {},
  });

applyTheme(getCurrentTheme());
createRoot(document.getElementById('root')!).render(
  <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
    <div style={{ flex: 1 }} />
    <StatusBar
      session={session}
      file={state.file ? <FileStatusItems id="f1" /> : undefined}
      showGit={state.detached ? undefined : () => state.opened++}
    />
  </div>,
);
