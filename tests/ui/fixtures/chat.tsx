// Isolated UI fixture. This is not part of the production entry point.
import { createRoot } from 'react-dom/client';
import type { ChatEvent } from '../../../src/features/chat/chatState';
import type { Profile } from '../../../src/lib/ipc';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

declare global {
  interface Window {
    __chat: { calls: { command: string; args: Record<string, unknown> }[] };
    /** The terminal connection a server chat shares, or null while it is down. */
    __via: string | null;
    /** Sends events to the chat as the backend would. */
    __chatEmit: (events: ChatEvent[]) => void;
    /** Sends a state to the chat's own login connection. */
    __linkEmit: (status: string, message: string) => void;
  }
}
window.__chat = { calls: [] };
window.__via = 'terminal-1';
const ssh = new URLSearchParams(location.search).has('ssh');

const callbacks = new Map<number, (message: unknown) => void>();
let nextCallback = 1;
let channel = 0;
let sent = 0;
let link = 0;
let linkSent = 0;
window.__linkEmit = (status, message) =>
  callbacks.get(link)?.({ message: { type: 'state', status, message }, index: linkSent++ });
window.__chatEmit = (events) => {
  // Tauri orders channel messages by an index, so each one needs the next number.
  for (const event of events) callbacks.get(channel)?.({ message: event, index: sent++ });
};

Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    // The composer listens for OS file drops on its window.
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main', windowLabel: 'main' },
    },
    transformCallback: (callback: (message: unknown) => void) => {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    invoke: async (command: string, args: Record<string, unknown>) => {
      if (command.startsWith('plugin:event|')) return 0;
      const { onEvent, ...plain } = args;
      window.__chat.calls.push({ command, args: plain });
      if (command === 'chat_pick_files') return ['/Users/me/work/app/notes.txt'];
      if (command === 'prompt_files_inspect')
        return (plain.paths as string[]).map((path) => ({
          name: path.split('/').at(-1),
          size: 1200,
        }));
      if (command === 'prompt_clipboard_inspect')
        return { item: { name: 'clipboard.png', size: 20480 }, digest: 'seen' };
      if (command === 'chat_clipboard_local') return '/tmp/dachsterm-chat/clipboard-1.png';
      if (['chat_start_local', 'chat_start', 'chat_attach'].includes(command)) {
        // Each reading is a new channel, and Tauri numbers its messages from zero.
        channel = (onEvent as { id: number }).id;
        sent = 0;
        return null;
      }
      if (command === 'chat_open') {
        link = (onEvent as { id: number }).id;
        linkSent = 0;
        return null;
      }
      if (
        [
          'chat_send',
          'chat_interrupt',
          'chat_close',
          'chat_disconnect',
          'chat_context',
          'chat_set_model',
          'chat_set_effort',
          'chat_set_mode',
          'chat_usage',
          'chat_set_ultracode',
          'chat_answer',
          'clipboard_write_text',
        ].includes(command)
      )
        return null;
      throw `unexpected ${command}`;
    },
  },
});

// Loaded after the stub, since `desktop` is read when the IPC module loads.
const { ChatSession } = await import('../../../src/features/chat/chatSession');
const { ChatPane } = await import('../../../src/features/chat/ChatPane');
applyTheme(getCurrentTheme());
const session = ssh
  ? new ChatSession(
      {
        kind: 'ssh',
        profile: {
          id: 'p1',
          name: 'web01',
          host: 'web01.example',
          port: 22,
          username: 'me',
        } as Profile,
        via: () => window.__via,
      },
      '/srv/app',
    )
  : new ChatSession({ kind: 'local', name: 'zsh · 기본 셸' }, '/Users/me/work/app');
session.open();
createRoot(document.getElementById('root')!).render(
  <div style={{ width: 900, height: 640, display: 'flex' }}>
    <ChatPane
      session={session}
      again={() => window.__chat.calls.push({ command: 'again', args: {} })}
    />
  </div>,
);
