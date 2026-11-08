import { useSyncExternalStore } from 'react';

export type SaveOutcome = 'saved' | 'conflict' | 'failed';

/**
 * A text file's live editing state, for what sits outside its tab: the tab header, closing, and the
 * save shortcuts. The tab owns the entry and removes it when it goes.
 */
export type FileDocument = {
  dirty: boolean;
  /** False when the file is read-only or its connection has ended. */
  canSave: boolean;
  save: () => Promise<SaveOutcome>;
  saveAs: () => void;
  /** Reads the file again, asking first if that would lose edits. */
  reload: () => void;
};

const documents = new Map<string, FileDocument>();
const listeners = new Set<() => void>();

export function setFileDocument(id: string, document: FileDocument | null) {
  if (document) documents.set(id, document);
  else documents.delete(id);
  listeners.forEach((listener) => listener());
}

export const fileDocument = (id: string) => documents.get(id);
export const unsavedFileIds = () =>
  [...documents].filter(([, document]) => document.dirty).map(([id]) => id);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const useFileDirty = (id: string) =>
  useSyncExternalStore(subscribe, () => documents.get(id)?.dirty ?? false);
