/** macOS draws its own window buttons and uses Command where other systems use Ctrl. */
export const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);

const macKeys: Record<string, string> = { Shift: '⇧', Alt: '⌥', Enter: '↩' };
/**
 * A Ctrl shortcut as this system writes it: `modKey('Shift+B')` is Ctrl+Shift+B, or ⌘⇧B on a Mac,
 * where the app takes Command in place of Ctrl.
 */
export function modKey(keys: string) {
  if (!isMac) return `Ctrl+${keys}`;
  return `⌘${keys
    .split('+')
    .map((key) => macKeys[key] ?? key)
    .join('')}`;
}
