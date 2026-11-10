// Isolated UI fixture. This is not part of the production entry point.
import { createRoot } from 'react-dom/client';
import type { ChatEvent } from '../../../src/features/chat/chatState';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

declare global {
  interface Window {
    __chat: { calls: { command: string; args: Record<string, unknown> }[] };
    /** Sends events to the chat as the backend would. */
    __chatEmit: (events: ChatEvent[]) => void;
  }
}
window.__chat = { calls: [] };

const callbacks = new Map<number, (message: unknown) => void>();
let nextCallback = 1;
let channel = 0;
let sent = 0;
window.__chatEmit = (events) => {
  // Tauri orders channel messages by an index, so each one needs the next number.
  for (const event of events) callbacks.get(channel)?.({ message: event, index: sent++ });
};

Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    transformCallback: (callback: (message: unknown) => void) => {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    invoke: async (command: string, args: Record<string, unknown>) => {
      const { onEvent, ...plain } = args;
      window.__chat.calls.push({ command, args: plain });
      if (command === 'chat_start_local') {
        channel = (onEvent as { id: number }).id;
        return null;
      }
      if (['chat_send', 'chat_interrupt', 'chat_close'].includes(command)) return null;
      throw `unexpected ${command}`;
    },
  },
});

// Loaded after the stub, since `desktop` is read when the IPC module loads.
const { ChatSession } = await import('../../../src/features/chat/chatSession');
const { ChatPane } = await import('../../../src/features/chat/ChatPane');
applyTheme(getCurrentTheme());
const session = new ChatSession({ kind: 'local', name: 'zsh · 기본 셸' }, '/Users/me/work/app');
session.open();
createRoot(document.getElementById('root')!).render(
  <div style={{ width: 900, height: 640, display: 'flex' }}>
    <ChatPane session={session} />
  </div>,
);
