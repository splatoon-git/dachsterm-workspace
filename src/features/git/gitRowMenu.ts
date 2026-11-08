import type { MenuItem } from '../../components/ContextMenu';
import type { GitRow } from './gitViewModel';

/** What a file's row can open. The tabs and the external editor belong to the app around the view. */
export type RowOpeners = {
  file: (path: string) => void;
  diff: (row: GitRow) => void;
  external: (path: string) => void;
};

/** A name that is not UTF-8 is not the real one, and a deleted file has nothing left to open. */
export const rowExists = (row: GitRow) => row.readable && row.change !== 'deleted';

/** A conflict has no single other side to compare with, so it only opens as a file. */
export function rowOpenItems(row: GitRow, path: string, openers: RowOpeners): MenuItem[] {
  const file: MenuItem = {
    label: '파일 열기',
    disabled: !rowExists(row),
    run: () => openers.file(path),
  };
  if (row.group === 'conflict') return [file];
  return [file, { label: 'diff 열기', disabled: !row.readable, run: () => openers.diff(row) }];
}
