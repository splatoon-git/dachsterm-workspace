import { useCallback, useSyncExternalStore } from 'react';
import type { TerminalSession } from '../features/terminal/session';
import type { GroupNode } from './workspaceLayout';

/**
 * The input target of each pane on screen, for typing into several at once. A pane showing the
 * Kubernetes workspace takes no part: its shell is hidden and nothing may be typed there.
 */
export function useInputPanes(
  panes: GroupNode[],
  activeSession: (group: GroupNode) => TerminalSession | undefined,
) {
  const sessions = panes.flatMap((group) => activeSession(group) ?? []);
  const key = sessions.map((session) => session.tabId).join(',');
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = sessions.map((session) => session.view.subscribe(listener));
      return () => stops.forEach((stop) => stop());
    },
    // The list is rebuilt each render; the tab IDs say when it really changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  useSyncExternalStore(subscribe, () =>
    sessions.map((session) => (showsWorkspace(session) ? 1 : 0)).join(''),
  );
  return panes.map((group) => {
    const session = activeSession(group);
    return session && !showsWorkspace(session) ? session.connectionId : group.id;
  });
}

function showsWorkspace(session: TerminalSession) {
  const { kube, kubeTerminal } = session.view.snapshot();
  return (session.profile.workspace === 'kubernetes' || kube) && !kubeTerminal;
}
