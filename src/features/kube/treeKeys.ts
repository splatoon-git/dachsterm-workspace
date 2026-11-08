export type TreeKeyAction =
  | 'down'
  | 'up'
  | 'collapse'
  | 'expand'
  | 'activate'
  | 'filter'
  | 'grouping'
  | 'home'
  | 'end'
  | 'pageDown'
  | 'pageUp';

/** By physical key: the letter a key produces changes with the input language (`ㅓ` for `j`). */
const actions: Record<string, TreeKeyAction> = {
  ArrowDown: 'down',
  KeyJ: 'down',
  ArrowUp: 'up',
  KeyK: 'up',
  ArrowLeft: 'collapse',
  KeyH: 'collapse',
  ArrowRight: 'expand',
  KeyL: 'expand',
  Enter: 'activate',
  NumpadEnter: 'activate',
  Space: 'activate',
  Slash: 'filter',
  KeyG: 'grouping',
  Home: 'home',
  End: 'end',
  PageDown: 'pageDown',
  PageUp: 'pageUp',
};

type Pressed = {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/** A key with a modifier belongs to the app or the OS, such as Ctrl+L or Shift+/. */
export function treeKeyAction(event: Pressed): TreeKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  return actions[event.code] ?? null;
}

/** Leaves the filter box for the results: after a composition ends, not to confirm one. */
export const leavesFilter = (event: { code: string; isComposing: boolean }) =>
  !event.isComposing && ['Enter', 'NumpadEnter', 'ArrowDown'].includes(event.code);
