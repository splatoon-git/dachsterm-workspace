// Isolated UI fixture: the real file row, workspace and file tab, with `file_read` answered here.
// This is not part of the production entry point and reads no real file.
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { FileOpenContext } from '../../../src/components/fileOpen';
import type { FileRead } from '../../../src/features/editor/fileRead';
import type { TerminalSession } from '../../../src/features/terminal/session';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

type Answer = FileRead | { fail: string };

declare global {
  interface Window {
    __fileTab: {
      /** By path, or `path|large` and `path|<encoding>` for a read with that option. */
      files: Record<string, Answer>;
      status: 'connected' | 'closed';
      calls: { path: string; options: { large: boolean; encoding: string | null } }[];
      opened: string[];
    };
    __pwned?: boolean;
  }
}

const state = window.__fileTab;
state.calls = [];
state.opened = [];
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (command: string, args: Record<string, unknown>) => {
      if (command === 'url_open') {
        state.opened.push(args.url as string);
        return null;
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
const snapshot = { status: state.status };
const session = {
  tabId: 't1',
  connectionId: 'c1',
  profile: { protocol: 'ssh', name: '서버' },
  subscribe: () => () => {},
  snapshot: () => snapshot,
} as unknown as TerminalSession;

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

function Harness() {
  const workspace = useWorkspaceLayout();
  const { open: openTab } = workspace;
  const files = useFileTabs({ workspace, sessions: [session], narrow: false });
  useEffect(() => openTab({ kind: 'session', tabId: 't1' }), [openTab]);
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
        <FileOpenContext.Provider value={(path, pinned) => files.open(session, path, pinned)}>
          {Object.keys(state.files)
            .filter((path) => !path.includes('|'))
            .map((path) => (
              <FileTreeRow
                key={path}
                row={row(path)}
                selected={false}
                toggle={() => {}}
                onDoubleClick={() => document.body.setAttribute('data-panel-open', path)}
              />
            ))}
        </FileOpenContext.Provider>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <WorkspaceGrid
          workspace={workspace}
          narrow={false}
          order={[{ kind: 'session', tabId: 't1' }, ...files.order]}
          detach={() => {}}
          renderTab={(tab, group) => {
            const key = tabKey(tab);
            const active = group.active === key;
            const select = () => workspace.select(group.id, key);
            return tab.kind === 'file' ? (
              files.renderTab(tab, active, select)
            ) : (
              <PlainTab tabKey={key} title="터미널" active={active} select={select} />
            );
          }}
          renderCell={(tab) => (tab.kind === 'file' ? files.renderCell(tab) : <p>터미널 화면</p>)}
        />
      </div>
      <footer aria-label="상태바" style={{ position: 'fixed', right: 0, bottom: 0 }}>
        {files.status(focusedTab)}
      </footer>
    </div>
  );
}

applyTheme(getCurrentTheme());
createRoot(document.getElementById('root')!).render(<Harness />);
