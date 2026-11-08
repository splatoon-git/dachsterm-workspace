/** What the branch badge on a terminal's prompt line says, and whether it has room. */
const maxCells = 24;
const minColumns = 40;
const gapCells = 2;

const wide = (code: number) =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe6f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1faff) ||
  (code >= 0x20000 && code <= 0x3fffd);

const charCells = (char: string) => (wide(char.codePointAt(0)!) ? 2 : 1);

/** Terminal cells the text takes, the same way the terminal counts East Asian wide characters. */
export const cells = (text: string) =>
  Array.from(text).reduce((sum, char) => sum + charCells(char), 0);

/** Shortens the middle so both the start and the end of a branch name stay readable. */
export function middleEllipsis(text: string, limit: number) {
  if (cells(text) <= limit) return text;
  const chars = Array.from(text);
  const room = Math.max(limit - 1, 1);
  const headRoom = Math.ceil(room / 2);
  let head = '';
  let used = 0;
  for (const char of chars) {
    if (used + charCells(char) > headRoom) break;
    head += char;
    used += charCells(char);
  }
  const tailRoom = room - used;
  let tail = '';
  let taken = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (taken + charCells(chars[i]) > tailRoom) break;
    tail = chars[i] + tail;
    taken += charCells(chars[i]);
  }
  return `${head}…${tail}`;
}

/** The badge's text, within its limit: `⎇ main` and, with changes, the count after it. */
export function badgeText(branch: string, count: string | null) {
  const suffix = count ? ` ●${count}` : '';
  return `⎇ ${middleEllipsis(branch, maxCells - cells('⎇ ') - cells(suffix))}${suffix}`;
}

type Line = {
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
};

/** The column after the last character on a line, counting a wide character's second cell. */
export function lineEnd(line: Line, columns: number) {
  for (let x = columns - 1; x >= 0; x--) {
    const cell = line.getCell(x);
    if (cell?.getChars()) return x + cell.getWidth();
  }
  return 0;
}

/**
 * A prompt theme's own branch, such as `(main)` or `on main`. A path that ends in a folder of the
 * same name is not one, so the character before must not be a path separator.
 */
export function promptShowsBranch(text: string, branch: string) {
  const word = /[\p{L}\p{N}_.-]/u;
  for (let at = text.indexOf(branch); at >= 0; at = text.indexOf(branch, at + 1)) {
    const before = text[at - 1] ?? '';
    const after = text[at + branch.length] ?? '';
    if (!/[/\\~]/.test(before) && !word.test(before) && after !== '/' && !word.test(after))
      return true;
  }
  return false;
}

/** The input line has room for the badge and two blank cells before it. */
export const badgeFits = (columns: number, end: number, width: number) =>
  columns >= minColumns && columns - end >= width + gapCells;
