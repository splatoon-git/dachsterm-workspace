// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { createRoot } from 'react-dom/client';
import type { DiffList, FileDiff, GitRefs } from '../../../src/features/git/gitDiff';
import type { Delivery } from '../../../src/features/git/review';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';
import '../../../src/app/workspaceGrid.css';

declare global {
  interface Window {
    __review: {
      width: number;
      refs: GitRefs;
      list: DiffList;
      files: Record<string, FileDiff>;
      delivery: Delivery;
      /** The error `git_refs` answers with, as for a folder outside a repository. */
      failRefs?: string;
      /** What the pane asked to paste, as it would for bracketed paste and for a plain shell. */
      sent: { multiline: string; plain: string }[];
      calls: { command: string; args: Record<string, unknown> }[];
      copied: string[];
    };
  }
}

const state = window.__review;
state.sent = [];
state.calls = [];
state.copied = [];
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (command: string, args: Record<string, unknown>) => {
      state.calls.push({ command, args });
      // A worktree reports itself as its own top level, as `rev-parse --show-toplevel` does.
      if (command === 'git_refs' && state.failRefs) throw state.failRefs;
      if (command === 'git_refs')
        return {
          ...structuredClone(state.refs),
          root: args.folder === '/srv/app/src' ? state.refs.root : args.folder,
        };
      if (command === 'git_diff_files') return structuredClone(state.list);
      if (command === 'git_diff_file')
        return structuredClone(state.files[args.path as string] ?? { kind: 'text', text: '' });
      if (command === 'clipboard_write_text') {
        state.copied.push(args.text as string);
        return null;
      }
      throw `unexpected ${command}`;
    },
  },
});

// Loaded after the stub, since `desktop` is read when the IPC module loads.
const { ReviewPane } = await import('../../../src/features/git/ReviewPane');
applyTheme(getCurrentTheme());
createRoot(document.getElementById('root')!).render(
  <div className="pane-cell" style={{ position: 'relative', width: state.width, height: 560 }}>
    <ReviewPane
      connectionId="c1"
      folder="/srv/app/src"
      target="배포 서버"
      send={(format) => {
        state.sent.push({ multiline: format(true), plain: format(false) });
        return state.delivery;
      }}
    />
  </div>,
);
