import { useSyncExternalStore } from 'react';
import type { GuideProgram } from './guideData';

/** What a pane shows on top of its terminal. Menus outside the pane open these. */
export type PaneViewState = {
  search: boolean;
  log: boolean;
  /** The full guide table, shown above the status bar. */
  guide: boolean;
  /** A guide the user chose; it stays until they release it. */
  pinned: GuideProgram | null;
  /** The tab menu opened the Kubernetes workspace on a terminal session. */
  kube: boolean;
  /** The workspace is open but the user went to its server terminal. */
  kubeTerminal: boolean;
};

const closed: PaneViewState = {
  search: false,
  log: false,
  guide: false,
  pinned: null,
  kube: false,
  kubeTerminal: false,
};

/** Per-session view state. It lives on the session so that moving a tab never resets it. */
export class PaneView {
  private state = closed;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  set(patch: Partial<PaneViewState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

export const usePaneView = (view: PaneView) => useSyncExternalStore(view.subscribe, view.snapshot);
