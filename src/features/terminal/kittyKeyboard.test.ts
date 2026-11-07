import { describe, expect, it } from 'vitest';
import { KittyKeyboard, modifiedEnter } from './kittyKeyboard';

const key = (patch: Partial<Parameters<typeof modifiedEnter>[0]>) => ({
  key: 'Enter',
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...patch,
});

describe('kitty keyboard state', () => {
  it('reports no flags until a program asks, and keeps only supported bits', () => {
    const keyboard = new KittyKeyboard();
    expect(keyboard.query('normal')).toBe('\x1b[?0u');
    // Measured: Claude Code 2.1.319 pushes 5, the disambiguate bit plus alternate key reporting.
    keyboard.push(5, 'normal');
    expect(keyboard.flags('normal')).toBe(1);
    expect(keyboard.query('normal')).toBe('\x1b[?1u');
  });

  it('restores the previous flags on pop and survives popping an empty stack', () => {
    const keyboard = new KittyKeyboard();
    keyboard.push(1, 'normal');
    keyboard.pop(1, 'normal');
    expect(keyboard.flags('normal')).toBe(0);
    keyboard.pop(3, 'normal');
    expect(keyboard.flags('normal')).toBe(0);
  });

  it('treats an omitted pop count as one', () => {
    const keyboard = new KittyKeyboard();
    keyboard.push(1, 'normal');
    keyboard.push(0, 'normal');
    keyboard.pop(0, 'normal');
    expect(keyboard.flags('normal')).toBe(1);
  });

  it('keeps the normal and alternate screens separate', () => {
    const keyboard = new KittyKeyboard();
    keyboard.push(1, 'alternate');
    expect(keyboard.flags('normal')).toBe(0);
    expect(keyboard.flags('alternate')).toBe(1);
  });

  it('bounds the stack and drops the oldest entry', () => {
    const keyboard = new KittyKeyboard();
    keyboard.push(1, 'normal');
    for (let i = 0; i < 20; i++) keyboard.push(0, 'normal');
    keyboard.pop(16, 'normal');
    expect(keyboard.flags('normal')).toBe(0);
    keyboard.pop(100, 'normal');
    expect(keyboard.flags('normal')).toBe(0);
  });

  it('applies set modes and ignores unknown ones', () => {
    const keyboard = new KittyKeyboard();
    keyboard.set(1, 2, 'normal');
    expect(keyboard.flags('normal')).toBe(1);
    keyboard.set(1, 3, 'normal');
    expect(keyboard.flags('normal')).toBe(0);
    keyboard.set(1, 1, 'normal');
    expect(keyboard.flags('normal')).toBe(1);
    keyboard.set(0, 9, 'normal');
    expect(keyboard.flags('normal')).toBe(1);
  });

  it('clears every screen on reset', () => {
    const keyboard = new KittyKeyboard();
    keyboard.push(1, 'normal');
    keyboard.push(1, 'alternate');
    keyboard.reset();
    expect(keyboard.flags('normal')).toBe(0);
    expect(keyboard.flags('alternate')).toBe(0);
  });
});

describe('modified Enter', () => {
  it('leaves every Enter alone until the program opts in', () => {
    expect(modifiedEnter(key({ shiftKey: true }), 0)).toBeNull();
  });

  it('encodes modifiers once the program opted in', () => {
    expect(modifiedEnter(key({ shiftKey: true }), 1)).toBe('\x1b[13;2u');
    expect(modifiedEnter(key({ altKey: true }), 1)).toBe('\x1b[13;3u');
    expect(modifiedEnter(key({ ctrlKey: true }), 1)).toBe('\x1b[13;5u');
    expect(modifiedEnter(key({ metaKey: true }), 1)).toBe('\x1b[13;9u');
  });

  it('uses the modifyOtherKeys form that tmux asks for', () => {
    expect(modifiedEnter(key({ shiftKey: true }), 0, 1)).toBe('\x1b[27;2;13~');
    expect(modifiedEnter(key({}), 0, 1)).toBeNull();
    expect(modifiedEnter(key({ ctrlKey: true, shiftKey: true }), 0, 1)).toBeNull();
  });

  it('prefers the kitty form when a program asked for both', () => {
    // Measured: Claude Code 2.1.319 sends CSI >5u and CSI >4;2m together.
    expect(modifiedEnter(key({ shiftKey: true }), 1, 2)).toBe('\x1b[13;2u');
  });

  it('keeps plain Enter and other keys as they are', () => {
    expect(modifiedEnter(key({}), 1)).toBeNull();
    expect(modifiedEnter(key({ key: 'a', shiftKey: true }), 1)).toBeNull();
  });

  it('never takes the app zoom shortcut', () => {
    expect(modifiedEnter(key({ ctrlKey: true, shiftKey: true }), 1)).toBeNull();
    expect(modifiedEnter(key({ metaKey: true, shiftKey: true }), 1)).toBeNull();
  });
});
