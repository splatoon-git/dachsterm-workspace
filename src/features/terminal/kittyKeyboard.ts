/**
 * The part of the kitty keyboard protocol that lets a program tell Shift+Enter from Enter.
 * Programs opt in, so shells and editors that never ask keep receiving plain carriage returns.
 *
 * Deliberately partial: only flag 1 (disambiguate) is reported, and only modified Enter changes
 * encoding. Every other key keeps its legacy sequence, which programs using this mode also accept.
 */
export type KeyboardScreen = 'normal' | 'alternate';

const supportedFlags = 1;
const stackDepth = 16;
const enterCode = 13;

type ScreenState = { flags: number; stack: number[] };

const blank = (): Record<KeyboardScreen, ScreenState> => ({
  normal: { flags: 0, stack: [] },
  alternate: { flags: 0, stack: [] },
});

export class KittyKeyboard {
  private screens = blank();
  /** xterm modifyOtherKeys level. tmux asks for this rather than the kitty protocol. */
  otherKeys = 0;
  flags(screen: KeyboardScreen) {
    return this.screens[screen].flags;
  }
  query(screen: KeyboardScreen) {
    return `\x1b[?${this.flags(screen)}u`;
  }
  push(flags: number, screen: KeyboardScreen) {
    const state = this.screens[screen];
    state.stack.push(state.flags);
    if (state.stack.length > stackDepth) state.stack.shift();
    state.flags = flags & supportedFlags;
  }
  pop(count: number, screen: KeyboardScreen) {
    const state = this.screens[screen];
    for (let i = 0; i < Math.max(count, 1); i++) state.flags = state.stack.pop() ?? 0;
  }
  /** Mode 1 replaces the flags, 2 adds bits and 3 removes them. */
  set(flags: number, mode: number, screen: KeyboardScreen) {
    const state = this.screens[screen];
    const bits = flags & supportedFlags;
    if (mode === 2) state.flags |= bits;
    else if (mode === 3) state.flags &= ~bits;
    else if (mode <= 1) state.flags = bits;
  }
  reset() {
    this.screens = blank();
    this.otherKeys = 0;
  }
}

type EnterEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>;

/** The sequence for a modified Enter, or null when the terminal should handle the key itself. */
export function modifiedEnter(event: EnterEvent, flags: number, otherKeys = 0) {
  if (event.key !== 'Enter' || (!(flags & 1) && otherKeys < 1)) return null;
  // Ctrl/Cmd+Shift+Enter is the app's zoom shortcut and must never reach the program.
  if ((event.ctrlKey || event.metaKey) && event.shiftKey) return null;
  const modifiers =
    (event.shiftKey ? 1 : 0) +
    (event.altKey ? 2 : 0) +
    (event.ctrlKey ? 4 : 0) +
    (event.metaKey ? 8 : 0);
  if (!modifiers) return null;
  return flags & 1
    ? `\x1b[${enterCode};${modifiers + 1}u`
    : `\x1b[27;${modifiers + 1};${enterCode}~`;
}
