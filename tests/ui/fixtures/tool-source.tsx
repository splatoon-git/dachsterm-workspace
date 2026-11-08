// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { createRoot } from 'react-dom/client';
import type { Profile } from '../../../src/lib/ipc';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import type { LinkEvent } from '../../../src/features/tools/sourceLink';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

interface ToolSourceFixture {
  calls: { command: string; args: Record<string, unknown> }[];
  /** Sends one event to the most recent `net_connect` channel. */
  emit: (event: LinkEvent) => void;
  /** `vault_status` says the vault is locked, and `unlock` answers it. */
  locked: boolean;
  unlock: () => void;
}
declare global {
  interface Window {
    __toolSource: ToolSourceFixture;
  }
}

const callbacks = new Map<number, (message: unknown) => void>();
let nextCallback = 1;
let lastChannel = 0;
const state: ToolSourceFixture = {
  calls: [],
  locked: false,
  unlock: () => {},
  emit: (event) => {
    // Tauri orders channel messages by an index, so each one needs the next number.
    callbacks.get(lastChannel)?.({ message: event, index: sent++ });
  },
};
let sent = 0;
window.__toolSource = state;
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    transformCallback: (callback: (message: unknown) => void) => {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    invoke: async (command: string, args: Record<string, unknown>) => {
      // A channel object cannot cross into the test, and only its ID matters here.
      const { onEvent, ...plain } = args;
      // Copied as the real bridge does: the login card wipes its array after sending.
      state.calls.push({ command, args: structuredClone(plain) });
      if (command === 'net_connect') {
        lastChannel = (onEvent as { id: number }).id;
        sent = 0;
      }
      return null;
    },
  },
});
applyTheme(getCurrentTheme());

// Loaded after the bridge above: `lib/ipc` decides whether it is on the desktop at import time.
const { default: ToolPane } = await import('../../../src/features/tools/ToolPane');
const { blankProfile } = await import('../../../src/lib/ipc');

const profile = (id: string, name: string, over: Partial<Profile> = {}): Profile => ({
  ...blankProfile(),
  id,
  name,
  host: `${id}.example`,
  username: 'deploy',
  ...over,
});
const profiles = [
  profile('web', '웹 서버'),
  profile('db', 'DB 서버', { hasSecret: true }),
  profile('files', '파일 서버', { protocol: 'ftp' }),
];

createRoot(document.getElementById('root')!).render(
  <ToolPane
    tool="portOpen"
    profiles={profiles}
    live={(id) => id === 'web'}
    vaultReady={async (retry) => {
      if (!state.locked) return true;
      state.unlock = () => {
        state.locked = false;
        retry();
      };
      return false;
    }}
  />,
);
