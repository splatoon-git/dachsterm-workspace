import { lazy, Suspense, useState } from 'react';
import { networkTools, type ToolId } from '../features/tools/catalog';
import type { VaultReady } from '../features/tools/useSource';
import type { TerminalSession } from '../features/terminal/session';
import { sessionKind } from '../features/terminal/sessionKind';
import type { Profile } from '../lib/ipc';
import { PlainTab } from './GroupTabBar';
import type { Workspace } from './useWorkspaceLayout';
import { tabKey, type TabRef } from './workspaceLayout';

const ToolPane = lazy(() => import('../features/tools/ToolPane'));
type ToolRef = Extract<TabRef, { kind: 'tool' }>;
const refOf = (id: ToolId): ToolRef => ({ kind: 'tool', id });

/** Network tool tabs. A tool opens once, and closing its tab lets go of its remote source. */
export function useToolTabs({
  workspace,
  profiles,
  sessions,
  vaultReady,
}: {
  workspace: Workspace;
  profiles: Profile[];
  sessions: TerminalSession[];
  vaultReady: VaultReady;
}) {
  const [open, setOpen] = useState<ToolId[]>([]);
  const close = (key: string) => {
    const id = open.find((tool) => tabKey(refOf(tool)) === key);
    if (!id) return false;
    setOpen((old) => old.filter((tool) => tool !== id));
    workspace.close(key);
    return true;
  };
  // Read when the list is drawn, so it shows the terminals as they are right then.
  const live = (profileId: string) =>
    sessions.some(
      (session) =>
        session.profile.id === profileId &&
        sessionKind(session) === 'ssh' &&
        session.snapshot().status === 'connected',
    );
  return {
    order: open.map(refOf),
    open: (id: ToolId) => {
      setOpen((old) => (old.includes(id) ? old : [...old, id]));
      workspace.open(refOf(id));
    },
    close,
    renderTab: (tab: ToolRef, active: boolean, select: () => void) => (
      <PlainTab
        tabKey={tabKey(tab)}
        title={networkTools.find((tool) => tool.id === tab.id)?.title ?? ''}
        active={active}
        select={select}
        close={() => close(tabKey(tab))}
      />
    ),
    renderCell: (tab: ToolRef, visible: boolean) => (
      <Suspense fallback={visible ? <p>준비 중…</p> : null}>
        <ToolPane tool={tab.id} profiles={profiles} live={live} vaultReady={vaultReady} />
      </Suspense>
    ),
  };
}
