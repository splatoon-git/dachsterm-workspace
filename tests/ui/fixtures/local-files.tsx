// Isolated UI fixture. This is not part of the production entry point.
import { createRoot } from 'react-dom/client';
import { FileDecorationsContext } from '../../../src/components/fileDecorations';
import type { FileEntry } from '../../../src/features/sftp/fileList';
import type { TerminalSession } from '../../../src/features/terminal/session';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

declare global {
  interface Window {
    /** Folders the app's own folder action was run on. */
    __chatHere: string[];
  }
}
window.__chatHere = [];

const entry = (name: string, directory: boolean): FileEntry => ({
  name,
  directory,
  symlink: false,
  size: directory ? null : 12,
  modified: null,
  permissions: null,
});

Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    // The panel listens for OS file drops on its window.
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main', windowLabel: 'main' },
    },
    transformCallback: () => 0,
    invoke: async (command: string, args: Record<string, unknown>) => {
      if (command.startsWith('plugin:event|')) return 0;
      if (command === 'local_files_home') return '/home/u';
      if (command === 'local_files_list')
        return { path: args.path, entries: [entry('project', true), entry('notes.txt', false)] };
      throw `unexpected ${command}`;
    },
  },
});

// The part of a local shell tab the panel reads. Following the shell's folder is off.
const snapshot = { status: 'connected', directory: null };
const session = {
  connectionId: 'local-1',
  profile: { protocol: 'ssh', name: 'zsh' },
  subscribe: () => () => {},
  snapshot: () => snapshot,
  wantsDirectoryFollow: () => false,
  canTypeDirectoryHook: () => false,
  fileLocation: () => null,
  rememberFileLocation: () => {},
} as unknown as TerminalSession;

// Loaded after the stub, since `desktop` is read when the IPC module loads.
const { LocalFilePanel } = await import('../../../src/features/sftp/LocalFilePanel');
applyTheme(getCurrentTheme());
createRoot(document.getElementById('root')!).render(
  <FileDecorationsContext.Provider
    value={{
      mark: () => undefined,
      listed: () => {},
      folderActions: (path) => [
        { label: '여기서 채팅 열기', run: () => window.__chatHere.push(path) },
      ],
    }}
  >
    <div className="workspace-sidebar" style={{ width: 320, height: 480, display: 'flex' }}>
      <div className="sidebar-file-panel">
        <LocalFilePanel
          session={session}
          target={{ id: 'default-shell', name: 'zsh', kind: 'shell', follow: 'none' }}
        />
      </div>
    </div>
  </FileDecorationsContext.Provider>,
);
