import { useEffect, useEffectEvent } from 'react';
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
  | { name: 'commands' }
  | { name: 'tunnels' }
  | { name: 'help' }
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
  KeyS: { name: 'commands' },
  KeyU: { name: 'tunnels' },
  // Ctrl+? as most apps write it. F1 stays with the terminal, where programs such as mc use it.
  Slash: { name: 'help' },
};

type Keys = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

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
export function useAppShortcuts(run: (shortcut: AppShortcut) => void) {
  const handle = useEffectEvent((e: KeyboardEvent) => {
    if (document.querySelector('dialog[open]')) return;
    const shortcut = appShortcut(e);
    if (!shortcut) return;
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
