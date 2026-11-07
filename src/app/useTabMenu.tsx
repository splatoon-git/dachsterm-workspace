import { useState } from 'react';
import { ContextMenu, type MenuPoint, type MenuRequest } from '../components/ContextMenu';
import { isRecording, logStatusOf } from '../features/terminal/logStatus';
import type { TerminalSession } from '../features/terminal/session';
import { capabilities } from '../features/terminal/sessionKind';
import { tabMenuEntries, type TabCommand } from './tabMenu';
import type { Beside, Workspace } from './useWorkspaceLayout';
import { groupOfTab, groups, tabKey } from './workspaceLayout';

export type TabActions = {
  /** Opens the same target again beside the group: a new connection and a new shell. */
  split: (session: TerminalSession, beside: Beside) => void;
  detach: (session: TerminalSession) => void;
  reconnect: (session: TerminalSession) => void;
  /** Closes any tab by its key, with the checks each kind needs. */
  close: (key: string) => void;
};

/** The tab header menu, shared by right-click, Shift+F10, the menu key and the ⋯ button. */
export function useTabMenu({
  workspace,
  narrow,
  sessionOf,
  actions,
}: {
  workspace: Workspace;
  narrow: boolean;
  sessionOf: (key: string) => TerminalSession | undefined;
  actions: TabActions;
}) {
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const open = (key: string, at: MenuPoint) => {
    const group = groupOfTab(workspace.layout.root, key);
    if (!group) return;
    const session = sessionOf(key);
    const status = session?.snapshot().status;
    const select = () => workspace.select(group.id, key);
    const run: Record<TabCommand, () => void> = {
      search: () => {
        select();
        session?.view.set({ search: true });
      },
      log: () => {
        select();
        session?.view.set({ log: true });
      },
      guide: () => {
        select();
        session?.view.set({ guide: true });
      },
      splitRight: () => session && actions.split(session, { groupId: group.id, side: 'right' }),
      splitDown: () => session && actions.split(session, { groupId: group.id, side: 'bottom' }),
      zoom: () => {
        select();
        workspace.toggleZoom();
      },
      detach: () => session && actions.detach(session),
      disconnect: () => void session?.disconnect(),
      reconnect: () => session && actions.reconnect(session),
      close: () => actions.close(key),
      closeOthers: () =>
        group.tabs.map(tabKey).forEach((other) => {
          if (other !== key) actions.close(other);
        }),
    };
    const entries = tabMenuEntries({
      capabilities: session ? capabilities(session) : null,
      connection: !session ? null : ['closed', 'error'].includes(status!) ? 'ended' : 'live',
      recording: !!session && isRecording(logStatusOf(session.connectionId)),
      groupCount: groups(workspace.layout.root).length,
      zoomed: workspace.zoomed,
      otherTabs: group.tabs.length - 1,
      narrow,
    });
    setMenu({
      at,
      items: entries.map((entry) => ({ ...entry, run: run[entry.command] })),
    });
  };
  const element = menu && (
    <ContextMenu label="탭 메뉴" at={menu.at} items={menu.items} close={() => setMenu(null)} />
  );
  return { open, element };
}
