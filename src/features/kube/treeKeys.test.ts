import { describe, expect, it } from 'vitest';
import { leavesFilter, treeKeyAction } from './treeKeys';

const press = (code: string, patch: Partial<Parameters<typeof treeKeyAction>[0]> = {}) =>
  treeKeyAction({
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...patch,
  });

describe('tree keys', () => {
  it('opens the shell and events by physical key, so a Korean input mode still works', () => {
    expect(press('KeyS')).toBe('shell');
    expect(press('KeyE')).toBe('events');
    expect(press('Escape')).toBe('close');
  });

  it.each([
    ['ArrowDown', 'down'],
    ['KeyJ', 'down'],
    ['ArrowUp', 'up'],
    ['KeyK', 'up'],
    ['ArrowLeft', 'collapse'],
    ['KeyH', 'collapse'],
    ['ArrowRight', 'expand'],
    ['KeyL', 'expand'],
    ['Enter', 'activate'],
    ['Slash', 'filter'],
    ['KeyG', 'grouping'],
  ])('%s is %s, whatever letter the input language makes', (code, action) => {
    expect(press(code)).toBe(action);
  });

  it('leaves other keys and modified keys to the app', () => {
    expect(press('KeyX')).toBeNull();
    expect(press('KeyJ', { ctrlKey: true })).toBeNull();
    expect(press('KeyL', { metaKey: true })).toBeNull();
    expect(press('Slash', { shiftKey: true })).toBeNull();
  });
});

describe('filter box', () => {
  it('moves to the results on Enter or the down arrow', () => {
    expect(leavesFilter({ code: 'Enter', isComposing: false })).toBe(true);
    expect(leavesFilter({ code: 'ArrowDown', isComposing: false })).toBe(true);
    expect(leavesFilter({ code: 'KeyA', isComposing: false })).toBe(false);
  });

  it('leaves Enter to the input method while a word is being composed', () => {
    expect(leavesFilter({ code: 'Enter', isComposing: true })).toBe(false);
  });
});
