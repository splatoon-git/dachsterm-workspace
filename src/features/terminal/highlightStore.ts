import { listen } from '@tauri-apps/api/event';
import { useSyncExternalStore } from 'react';
import { call, desktop } from '../../lib/ipc';
import type { HighlightLibrary, HighlightRule } from './highlightRules';

/** Emitted by `highlights.rs` after a save, so every window reads the same rules. */
const changedEvent = 'highlight-rules';

let library: HighlightLibrary = { revision: 0, items: [] };
/** Rules stopped in this run because matching took too long, until their pattern changes. */
const stopped = new Set<string>();
const stopKey = (rule: HighlightRule) => `${rule.id}\u0000${rule.ignoreCase}\u0000${rule.pattern}`;
let loadError = '';
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

/** Takes a library the backend returned, from a read or a save. */
export function applyHighlightLibrary(next: HighlightLibrary) {
  library = next;
  loadError = '';
  notify();
}

export async function reloadHighlightRules() {
  try {
    applyHighlightLibrary(await call<HighlightLibrary>('highlight_rules'));
  } catch (e) {
    loadError = typeof e === 'string' ? e : '하이라이트 규칙을 읽지 못했습니다.';
    notify();
  }
}

if (desktop) {
  void reloadHighlightRules();
  // The listener lives as long as the window; a window that misses an event reads on next save.
  void listen(changedEvent, () => void reloadHighlightRules()).catch(() => {});
}

export async function saveHighlightRules(items: HighlightRule[]) {
  applyHighlightLibrary(
    await call<HighlightLibrary>('highlight_rules_save', { revision: library.revision, items }),
  );
}

/** Stops a rule for this run and returns its name, after its matching ran too long. */
export function stopHighlightRule(id: string) {
  const rule = library.items.find((item) => item.id === id);
  if (!rule) return '';
  stopped.add(stopKey(rule));
  notify();
  return rule.name;
}

/** The rules that can run now. */
export const activeHighlightRules = () =>
  library.items.filter((rule) => rule.enabled && !stopped.has(stopKey(rule)));
export const highlightLibrary = () => library;
export const highlightLoadError = () => loadError;
export const highlightRuleStopped = (rule: HighlightRule) => stopped.has(stopKey(rule));

export function subscribeHighlightRules(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const useHighlightLibrary = () =>
  useSyncExternalStore(subscribeHighlightRules, highlightLibrary);
