import { describe, expect, it } from 'vitest';
import { appShortcut, closesTab } from './appShortcuts';

const key = (
  code: string,
  mods: Partial<Record<'ctrl' | 'meta' | 'shift' | 'alt', boolean>> = {},
) => ({
  code,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe('app shortcuts', () => {
  it('maps the new shortcuts with Ctrl or Command', () => {
    expect(appShortcut(key('KeyM', { ctrl: true, shift: true }))).toEqual({ name: 'inputScope' });
    expect(appShortcut(key('Backslash', { meta: true, shift: true }))).toEqual({
      name: 'splitRight',
    });
    expect(appShortcut(key('KeyF', { ctrl: true, shift: true }))).toEqual({
      name: 'terminalSearch',
    });
    expect(appShortcut(key('KeyO', { meta: true, shift: true }))).toEqual({
      name: 'sessionSearch',
    });
    expect(appShortcut(key('ArrowUp', { meta: true, alt: true }))).toEqual({
      name: 'moveFocus',
      side: 'top',
    });
  });

  it('leaves shell and editor keys to the terminal', () => {
    for (const code of ['KeyF', 'KeyB', 'KeyM', 'Backslash', 'KeyC', 'KeyV'])
      expect(appShortcut(key(code, { ctrl: true }))).toBeNull();
    // Copy and paste stay with the terminal's own Ctrl+Shift handling.
    expect(appShortcut(key('KeyC', { ctrl: true, shift: true }))).toBeNull();
    expect(appShortcut(key('KeyV', { ctrl: true, shift: true }))).toBeNull();
    expect(appShortcut(key('KeyM', { shift: true }))).toBeNull();
    expect(appShortcut(key('KeyM', { ctrl: true, shift: true, alt: true }))).toBeNull();
    expect(appShortcut(key('ArrowUp', { ctrl: true, alt: true, shift: true }))).toBeNull();
  });

  it('opens the header tools from the keyboard', () => {
    expect(appShortcut(key('KeyS', { ctrl: true, shift: true }))).toEqual({ name: 'commands' });
    expect(appShortcut(key('KeyU', { meta: true, shift: true }))).toEqual({ name: 'tunnels' });
    expect(appShortcut(key('Slash', { ctrl: true, shift: true }))).toEqual({ name: 'help' });
    expect(appShortcut(key('Comma', { meta: true }))).toEqual({ name: 'settings' });
    expect(appShortcut(key('Period', { ctrl: true, shift: true }))).toEqual({ name: 'nextAgent' });
    expect(appShortcut(key('Period', { meta: true, shift: true }))).toEqual({ name: 'nextAgent' });
    expect(appShortcut(key('Period', { ctrl: true }))).toBeNull();
    // Ctrl+S is the terminal's XOFF and F1 is help in programs such as mc.
    expect(appShortcut(key('KeyS', { ctrl: true }))).toBeNull();
    expect(appShortcut(key('F1'))).toBeNull();
    expect(appShortcut(key('Comma', { ctrl: true, shift: true }))).toBeNull();
  });

  it('opens the change review with Shift+G and leaves Ctrl+G to the terminal', () => {
    expect(appShortcut(key('KeyG', { ctrl: true, shift: true }))).toEqual({ name: 'review' });
    expect(appShortcut(key('KeyG', { meta: true, shift: true }))).toEqual({ name: 'review' });
    expect(appShortcut(key('KeyG', { ctrl: true }))).toBeNull();
  });

  it('keeps F11 for full screen', () => {
    expect(appShortcut(key('F11'))).toEqual({ name: 'fullscreen' });
  });

  it('closes a tab with Command+W only, and leaves Ctrl+W to the shell', () => {
    expect(closesTab(key('KeyW', { meta: true }))).toBe(true);
    expect(closesTab(key('KeyW', { ctrl: true }))).toBe(false);
    expect(closesTab(key('KeyW', { meta: true, shift: true }))).toBe(false);
    expect(closesTab(key('KeyW', { meta: true, alt: true }))).toBe(false);
    expect(closesTab(key('KeyQ', { meta: true }))).toBe(false);
    expect(appShortcut(key('KeyW', { meta: true }))).toBeNull();
  });
});
