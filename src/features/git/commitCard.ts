import type { DiffFile } from './gitDiff';

const coAuthor = /^co-authored-by:\s*(.*?)\s*(?:<[^>]*>)?\s*$/i;

/** A commit message without its co-author lines, which the card shows under the author. */
export function commitMessage(message: string) {
  const coAuthors: string[] = [];
  const lines = message.split('\n').filter((line) => {
    const found = coAuthor.exec(line.trim());
    if (found?.[1]) coAuthors.push(found[1]);
    return !found;
  });
  return { body: lines.join('\n').trimEnd(), coAuthors };
}

/** `time` is seconds since the epoch. */
export function relativeTime(time: number, now = Date.now()) {
  const minutes = Math.floor((now / 1000 - time) / 60);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}개월 전` : `${Math.floor(days / 365)}년 전`;
}

/** A binary file has no line counts and adds none to the total. */
export function fileTotals(files: Pick<DiffFile, 'added' | 'removed'>[]) {
  return {
    files: files.length,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
  };
}

type Size = { width: number; height: number };

/** Beside the row, or on its other side when the window is too narrow; never off the window. */
export function placeCard(
  row: { left: number; right: number; top: number },
  card: Size,
  window: Size,
) {
  const gap = 4;
  const fits = row.right + gap + card.width <= window.width - gap;
  return {
    x: fits ? row.right + gap : Math.max(gap, row.left - gap - card.width),
    y: Math.max(gap, Math.min(row.top, window.height - gap - card.height)),
  };
}
