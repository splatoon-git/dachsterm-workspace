// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { createRoot } from 'react-dom/client';
import type {
  GitConfigChange,
  GitConfigEntry,
  GitConfigScope,
} from '../../../src/features/settings/gitConfigModel';
import type { LocalCatalog } from '../../../src/features/terminal/sessionTypes';
import type { Source } from '../../../src/lib/source';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

type Reach = { source: Source; scope: GitConfigScope };
export type ProgramInfo = {
  chosen: string | null;
  found: string | null;
  version: string | null;
  problem: string | null;
};

declare global {
  interface Window {
    __gitSettings: {
      program: ProgramInfo;
      /** Answer of `git_program_set` for a path, or the error text to refuse it with. */
      pick: string | null;
      refuse: string | null;
      entries: Record<string, GitConfigEntry[]>;
      /** The error of the next read or write. */
      readError: string | null;
      writeError: string | null;
      writes: { key: string; changes: GitConfigChange[] }[];
      /** Commands the real preview would return for the changes, one per change. */
      calls: { command: string; args: Record<string, unknown> }[];
    };
  }
}

const state = window.__gitSettings;
state.calls = [];
state.writes = [];

const keyOf = ({ source, scope }: Reach) =>
  `${source.kind === 'local' ? source.targetId : 'ssh'}:${scope.kind}`;
const shown = (change: GitConfigChange) =>
  change.op === 'set'
    ? `git config ${change.key} ${change.value}`
    : change.op === 'add'
      ? `git config --add ${change.key} ${change.value}`
      : `git config --unset ${change.key}`;
const catalog: LocalCatalog = {
  targets: [
    { id: 'pwsh', name: 'PowerShell', kind: 'shell', follow: 'launch' },
    { id: 'wsl:Ubuntu', name: 'Ubuntu', kind: 'wsl', follow: 'launch' },
  ],
  warning: null,
};

Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (command: string, args: Record<string, unknown>) => {
      state.calls.push({ command, args });
      if (command === 'local_targets') return catalog;
      if (command === 'git_program_info') return structuredClone(state.program);
      if (command === 'git_program_pick') return state.pick;
      if (command === 'git_program_set') {
        if (state.refuse) throw state.refuse;
        state.program.chosen = (args.path as string | null) ?? null;
        return structuredClone(state.program);
      }
      if (command === 'git_config_read') {
        if (state.readError) throw state.readError;
        return structuredClone(state.entries[keyOf(args as Reach)] ?? []);
      }
      if (command === 'git_config_preview') return (args.changes as GitConfigChange[]).map(shown);
      if (command === 'git_config_write') {
        if (state.writeError) throw state.writeError;
        const key = keyOf(args as Reach);
        const changes = args.changes as GitConfigChange[];
        state.writes.push({ key, changes });
        const list = (state.entries[key] ??= []);
        for (const change of changes) {
          const at = list.findIndex((e) => e.key === change.key);
          if (change.op === 'unset') list.splice(at, 1);
          else if (at >= 0) list[at] = { key: change.key, values: [change.value], hidden: false };
          else list.push({ key: change.key, values: [change.value], hidden: false });
        }
        return null;
      }
      if (command === 'local_agent_settings')
        return { enabled: false, keys: [], wslGitCredentials: false };
      if (command === 'git_credentials_saved') return [];
      throw `unexpected ${command}`;
    },
  },
});

// Loaded after the stub, since `desktop` is read when the IPC module loads.
const { GitSettingsSection } = await import('../../../src/app/GitSettingsSection');
applyTheme(getCurrentTheme());
const repo = new URLSearchParams(location.search).get('repo');
createRoot(document.getElementById('root')!).render(
  <div className="dialog-body" style={{ maxWidth: 720 }}>
    <GitSettingsSection
      session={undefined}
      repo={repo ? { source: { kind: 'local', targetId: 'pwsh' }, folder: repo } : undefined}
    />
  </div>,
);
