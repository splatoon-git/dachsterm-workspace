import { useSyncExternalStore } from 'react';
import type { TextFacts } from './fileText';

/** What the status bar shows for a file tab. The tab owns it; the bar lives outside the tab. */
export type FileStatus = TextFacts & {
  encoding: string;
  language: string;
  chooseEncoding: (encoding: string) => void;
};

const statuses = new Map<string, FileStatus>();
const listeners = new Set<() => void>();

export function setFileStatus(id: string, status: FileStatus | null) {
  if (status) statuses.set(id, status);
  else statuses.delete(id);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const useFileStatus = (id: string) =>
  useSyncExternalStore(subscribe, () => statuses.get(id));
