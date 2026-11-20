import type { Plugin } from 'vite';

export function packageFolders(folders: Record<string, { from: string; skip?: RegExp }>): Plugin;
