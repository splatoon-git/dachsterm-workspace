import { createContext, useContext } from 'react';
import type { MenuItem } from './ContextMenu';

/** A letter for a changed file, or `folder` for a folder with changes inside. */
export type FileMark = 'M' | 'A' | 'D' | '?' | 'U' | 'folder';
/**
 * Marks for the rows of a file tree, given by the app so the tree needs no knowledge of where they
 * come from. Paths are absolute. `listed` reports each listing, which may refresh the marks.
 * `folderActions` adds the app's own items to a folder's menu, such as starting an agent there.
 */
export type FileDecorations = {
  mark(path: string): FileMark | undefined;
  listed(folder: string): void;
  folderActions?(path: string): MenuItem[];
};
export const fileMarkLabels: Record<FileMark, string> = {
  M: '수정',
  A: '추가',
  D: '삭제',
  '?': '추적 안 함',
  U: '충돌',
  folder: '하위 변경 있음',
};
export const FileDecorationsContext = createContext<FileDecorations | null>(null);
export const useFileDecorations = () => useContext(FileDecorationsContext);
