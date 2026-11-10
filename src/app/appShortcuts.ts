import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useEffectEvent } from 'react';
import { desktop } from '../lib/ipc';
import type { Side } from './workspaceLayout';

/** App-wide shortcuts. Each takes Ctrl, or Command on a Mac, so typing in a shell never hits one. */
export type AppShortcut =
  | { name: 'fullscreen' }
  | { name: 'moveFocus'; side: Side }
  | { name: 'zoom' }
  | { name: 'local' }
  | { name: 'newConnection' }
  | { name: 'sidebar' }
  | { name: 'terminalSearch' }
  | { name: 'sessionSearch' }
  | { name: 'files' }
  | { name: 'inputScope' }
  | { name: 'splitRight' }
  | { name: 'review' }
  | { name: 'commands' }
  | { name: 'tunnels' }
  | { name: 'help' }
  | { name: 'nextAgent' }
  | { name: 'chat' }
  | { name: 'settings' };

const sides: Record<string, Side> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'top',
  ArrowDown: 'bottom',
};
/** Ctrl/Cmd+Shift with one key. Keys like Ctrl+F and Ctrl+B belong to shells and editors. */
const withShift: Record<string, AppShortcut> = {
  Enter: { name: 'zoom' },
  KeyL: { name: 'local' },
  KeyN: { name: 'newConnection' },
  KeyB: { name: 'sidebar' },
  KeyF: { name: 'terminalSearch' },
  KeyO: { name: 'sessionSearch' },
  KeyE: { name: 'files' },
  KeyM: { name: 'inputScope' },
  Backslash: { name: 'splitRight' },
  KeyG: { name: 'review' },
  KeyS: { name: 'commands' },
  KeyU: { name: 'tunnels' },
  // Ctrl+? as most apps write it. F1 stays with the terminal, where programs such as mc use it.
  Slash: { name: 'help' },
  // Ctrl+> as "next". No control character or common program binding uses Ctrl+Shift+period.
  Period: { name: 'nextAgent' },
  // A for agent. L, which editors use for chat, already opens a local terminal here.
  KeyA: { name: 'chat' },
};

type Keys = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

/**
 * Command+W closes the focused tab, as in other Mac apps, and with no tab left the window. The menu
 * has no Close Window (`macos_menu.rs`): it closed the window, and so quit, on the first press.
 * Ctrl+W stays with the shell, where it deletes a word.
 */
export const closesTab = (e: Keys) =>
  e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyW';

/** Closes this window through its usual checks (`useWindowClose`). */
export function closeWindow() {
  // A refused close is the user's answer to those checks, and nothing else can go wrong here.
  if (desktop)
    void getCurrentWindow()
      .close()
      .catch(() => {});
}

/** The shortcut a key press means, by physical key so a keyboard layout does not change it. */
export function appShortcut(e: Keys): AppShortcut | null {
  if (e.code === 'F11') return { name: 'fullscreen' };
  if (!(e.ctrlKey || e.metaKey)) return null;
  if (e.altKey && !e.shiftKey)
    return e.code in sides ? { name: 'moveFocus', side: sides[e.code] } : null;
  if (e.shiftKey && !e.altKey) return withShift[e.code] ?? null;
  // Ctrl+, sends no control character, and Command+, opens settings in every Mac app.
  if (!e.shiftKey && !e.altKey && e.code === 'Comma') return { name: 'settings' };
  return null;
}

/**
 * Runs app shortcuts before the terminal sees the key. A dialog keeps its keys, and a key that is
 * not a shortcut goes on to the terminal untouched.
 */
export function useAppShortcuts(
  /** A shortcut the focused content uses itself right now. */
  keptByContent: (shortcut: AppShortcut) => boolean,
  run: (shortcut: AppShortcut) => void,
  /** False when there was no tab to close. */
  closeTab: () => boolean,
) {
  const handle = useEffectEvent((e: KeyboardEvent) => {
    const close = closesTab(e);
    // Even under a dialog, or the menu would still quit the app.
    if (close) e.preventDefault();
    if (document.querySelector('dialog[open]')) return;
    if (close) {
      e.stopPropagation();
      if (!closeTab()) closeWindow();
      return;
    }
    const shortcut = appShortcut(e);
    if (!shortcut || keptByContent(shortcut)) return;
    e.preventDefault();
    e.stopPropagation();
    run(shortcut);
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => handle(e);
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);
}
