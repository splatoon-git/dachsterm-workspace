import { createContext, useContext } from 'react';

/**
 * Opens a file row in a tab of the main window. `pinned` is false for the preview a single click
 * opens. A window without tabs provides nothing, and its panels keep their own double-click.
 */
export type FileOpener = (path: string, pinned: boolean) => void;

export const FileOpenContext = createContext<FileOpener | null>(null);
export const useFileOpener = () => useContext(FileOpenContext);
