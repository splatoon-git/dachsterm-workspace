import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Window } from '@tauri-apps/api/window';
import type { TerminalSession } from '../features/terminal/session';
import { desktop, errorText } from '../lib/ipc';
import {
  agentStatusEvent,
  nextBlocked,
  parseAgentStatus,
  sortRows,
  tabRowKey,
  type AgentRow,
} from './agentRows';
import { agentReportOf, watchAgentReport } from './agentStatus';
import type { TabRef } from './workspaceLayout';
import { focusActiveTerminal } from './WorkspaceGrid';

/** What the status bar item shows and does. The list is already in order. */
export type AgentBoardState = {
  rows: AgentRow[];
  activate(row: AgentRow): void;
};

const same = (a: AgentRow[], b: AgentRow[]) => JSON.stringify(a) === JSON.stringify(b);

/** The rows of this window's tabs, recomputed only when one of them reports a change. */
class TabRows {
  private rows: AgentRow[] = [];
  constructor(private readonly tabs: readonly TerminalSession[]) {
    this.rows = this.read();
  }
  private read() {
    return this.tabs.flatMap((tab) => {
      const report = agentReportOf(tab);
      return report ? [{ ...report, key: tabRowKey(tab.tabId) }] : [];
    });
  }
  subscribe = (listener: () => void) => {
    const changed = () => {
      const next = this.read();
      if (same(next, this.rows)) return;
      this.rows = next;
      listener();
    };
    const stops = this.tabs.map((tab) => watchAgentReport(tab, changed));
    changed();
    return () => stops.forEach((stop) => stop());
  };
  snapshot = () => this.rows;
}

/**
 * Rows reported by independent windows. A row lives until its window sends nothing to report or
 * is destroyed. Storage events are not used: they never reach the same window (rules §7).
 */
function useWindowRows() {
  const [rows, setRows] = useState<ReadonlyMap<string, AgentRow>>(new Map());
  const drop = useCallback(
    (label: string) =>
      setRows((old) => {
        if (!old.has(label)) return old;
        const next = new Map(old);
        next.delete(label);
        return next;
      }),
    [],
  );
  useEffect(() => {
    if (!desktop) return;
    const watched = new Map<string, Promise<UnlistenFn>>();
    const closed = (label: string) => {
      drop(label);
      void watched.get(label)?.then((stop) => stop());
      watched.delete(label);
    };
    const watch = (label: string) => {
      if (watched.has(label)) return;
      const stop = listen('tauri://destroyed', () => closed(label), {
        target: { kind: 'Window', label },
      });
      watched.set(label, stop);
      // A window destroyed before this listener started sends no event, so look once.
      void stop
        .then(() => Window.getByLabel(label))
        .then((window) => {
          if (!window) closed(label);
        })
        .catch(() => closed(label));
    };
    const status = listen<unknown>(agentStatusEvent, (event) => {
      const message = parseAgentStatus(event.payload);
      if (!message) return;
      const { window: label, report } = message;
      if (!report) return drop(label);
      watch(label);
      setRows((old) =>
        new Map(old).set(label, { ...report, key: `window:${label}`, window: label }),
      );
    });
    return () => {
      void status.then((stop) => stop());
      watched.forEach((stop) => void stop.then((unlisten) => unlisten()));
    };
  }, [drop]);
  return { rows, drop };
}

/**
 * Everything the main window's agent list needs: rows from its own tabs and from independent
 * windows, and how to go to one.
 */
export function useAgentBoard({
  tabs,
  selected,
  open,
  fail,
}: {
  tabs: readonly TerminalSession[];
  /** The focused tab, from which the next waiting tab is found. */
  selected?: TerminalSession;
  open(tab: TabRef): void;
  fail(message: string): void;
}) {
  const local = useMemo(() => new TabRows(tabs), [tabs]);
  const own = useSyncExternalStore(local.subscribe, local.snapshot);
  const windows = useWindowRows();
  const rows = useMemo(() => sortRows([...own, ...windows.rows.values()]), [own, windows.rows]);
  const activate = (row: AgentRow) => {
    if (row.window) {
      const label = row.window;
      void Window.getByLabel(label)
        .then(async (window) => {
          if (!window) return windows.drop(label);
          await window.unminimize();
          await window.setFocus();
        })
        .catch((e) => fail(errorText(e)));
      return;
    }
    const tab = tabs.find((t) => tabRowKey(t.tabId) === row.key);
    if (!tab) return;
    open({ kind: 'session', tabId: tab.tabId });
    focusActiveTerminal();
  };
  return {
    rows,
    activate,
    /** Goes to the next tab waiting for input. */
    next: () => {
      const row = nextBlocked(rows, selected && tabRowKey(selected.tabId));
      if (row) activate(row);
    },
  };
}
