// Isolated UI fixture for the group layout. It uses the real grid with plain cells, no terminals.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlainTab } from '../../../src/app/GroupTabBar';
import { useWorkspaceLayout, type Workspace } from '../../../src/app/useWorkspaceLayout';
import { WorkspaceGrid, type CellState } from '../../../src/app/WorkspaceGrid';
import { tabKey, type GroupNode, type TabRef } from '../../../src/app/workspaceLayout';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

applyTheme(getCurrentTheme());

declare global {
  interface Window {
    __grid: { workspace: Workspace; mounts: Record<string, number> };
  }
}
const mounts: Record<string, number> = {};

function Cell({ name, state }: { name: string; state: CellState }) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    mounts[name] = (mounts[name] ?? 0) + 1;
  }, [name]);
  return (
    <div
      data-testid={`cell-${name}`}
      data-visible={state.visible}
      data-focused={state.focused}
      style={{ flex: 1, padding: 8 }}
    >
      <label>
        {name} 입력
        <input value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
    </div>
  );
}

const names = ['a', 'b', 'c', 'd'];
const params = new URLSearchParams(location.search);
const count = Number(params.get('tabs') ?? names.length);
const order: TabRef[] = names.slice(0, count).map((tabId) => ({ kind: 'session', tabId }));

function Fixture() {
  const workspace = useWorkspaceLayout();
  const { open } = workspace;
  useEffect(() => order.forEach(open), [open]);
  useEffect(() => {
    window.__grid = { workspace, mounts };
  });
  const renderTab = (tab: TabRef, group: GroupNode) => {
    const key = tabKey(tab);
    const name = tab.kind === 'session' ? tab.tabId : key;
    return (
      <PlainTab
        tabKey={key}
        title={name}
        active={group.active === key}
        select={() => workspace.select(group.id, key)}
        close={() => workspace.close(key)}
      />
    );
  };
  return (
    <WorkspaceGrid
      workspace={workspace}
      narrow={params.has('narrow')}
      order={order}
      renderTab={renderTab}
      renderCell={(tab, state) => (
        <Cell name={tab.kind === 'session' ? tab.tabId : tabKey(tab)} state={state} />
      )}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
    <Fixture />
  </div>,
);
