import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { ContextMenu, type MenuPoint, type MenuRequest } from '../../components/ContextMenu';
import { ResizeHandle } from '../../components/ResizeHandle';
import type { KubeSettings } from '../../lib/ipc';
import { KubePodPanel } from './KubePodPanel';
import { KubeTree, type PodAction } from './KubeTree';
import type { PodRef } from './detailTypes';
import { scopeOfGroup, type SearchScope } from './logSearchModel';
import { detailTab, type PodPanelTarget } from './podPanel';
import type { PodTerminalRequest } from './podShell';
import type { SnapshotStore } from './polling';
import type { TreeGroup, TreeView } from './tree';
import type { PodView } from './treePods';
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, usePanelWidth } from './usePanelWidth';
import { usePodShell } from './usePodShell';

export type PanelState = (PodPanelTarget & { problem: boolean }) | null;

/** The tree and everything that happens to one of its pods. */
export function KubeTreeScreen({
  store,
  session,
  focused,
  view,
  setView,
  connectionId,
  kube,
  panel,
  setPanel,
  focusPod,
  openTerminal,
  searchLogs,
}: {
  store: SnapshotStore;
  session: string;
  focused: boolean;
  view: TreeView;
  setView: Dispatch<SetStateAction<TreeView>>;
  connectionId: string;
  kube: KubeSettings;
  panel: PanelState;
  setPanel: Dispatch<SetStateAction<PanelState>>;
  focusPod: PodRef | null;
  openTerminal: (request: PodTerminalRequest) => void;
  searchLogs: (scope: SearchScope) => void;
}) {
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState<(MenuRequest & { label?: string }) | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const { width, change } = usePanelWidth();
  const openShell = usePodShell({
    connectionId,
    kube,
    session,
    openTerminal,
    notify: setNotice,
    openMenu: setMenu,
  });

  const showPanel = (item: PodView, tab: PodPanelTarget['tab']) => {
    setNotice('');
    setPanel({ namespace: item.pod.namespace, name: item.pod.name, tab, problem: item.problem });
  };

  const handle = (action: PodAction, item: PodView, at?: MenuPoint): void => {
    switch (action) {
      case 'logs':
        return showPanel(item, 'logs');
      case 'events':
        return showPanel(item, 'events');
      case 'detail':
        return showPanel(item, detailTab(item.problem));
      case 'shell':
        return void openShell({ namespace: item.pod.namespace, name: item.pod.name }, at);
      case 'menu':
        return setMenu({
          at: at ?? { x: 0, y: 0 },
          items: [
            { label: '로그', shortcut: 'Enter', run: () => handle('logs', item) },
            { label: '셸', shortcut: 's', run: () => handle('shell', item, at) },
            { label: '이벤트', shortcut: 'e', run: () => handle('events', item) },
            { label: '상세', run: () => handle('detail', item) },
            {
              label: '로그 검색',
              separated: true,
              run: () =>
                searchLogs({ kind: 'pod', value: `${item.pod.namespace}/${item.pod.name}` }),
            },
          ],
        });
    }
  };
  // The tree is memoized and redraws only for new data, so it gets one function for its lifetime.
  const latest = useRef(handle);
  useLayoutEffect(() => {
    latest.current = handle;
  });
  const onPod = useCallback(
    (action: PodAction, item: PodView, at?: MenuPoint) => latest.current(action, item, at),
    [],
  );
  const onGroup = useCallback(
    (group: TreeGroup, at?: MenuPoint) => {
      const scope = scopeOfGroup(group.id);
      if (scope)
        setMenu({
          at: at ?? { x: 0, y: 0 },
          label: '그룹 메뉴',
          items: [{ label: '로그 검색', run: () => searchLogs(scope) }],
        });
    },
    [searchLogs],
  );
  const closePanel = useCallback(() => {
    setPanel(null);
    setFocusSignal((n) => n + 1);
  }, [setPanel]);

  return (
    <div className="kube-tree-screen">
      {notice && (
        <div className="kube-notice" role="alert">
          <span>{notice}</span>
          <button aria-label="안내 닫기" onClick={() => setNotice('')}>
            ×
          </button>
        </div>
      )}
      <div className="kube-split">
        <KubeTree
          store={store}
          session={session}
          focused={focused}
          view={view}
          setView={setView}
          onPod={onPod}
          onGroup={onGroup}
          panelOpen={panel !== null}
          closePanel={closePanel}
          focusPod={focusPod}
          focusSignal={focusSignal}
        />
        {panel && (
          <>
            <ResizeHandle
              value={width}
              min={PANEL_MIN_WIDTH}
              max={PANEL_MAX_WIDTH}
              reverse
              onChange={change}
              label="로그 패널 크기"
            />
            <KubePodPanel
              key={`${panel.namespace}/${panel.name}`}
              connectionId={connectionId}
              kube={kube}
              session={session}
              target={panel}
              store={store}
              style={{ width: `min(${width}px, 70%)` }}
              setTab={(tab) => setPanel((now) => (now ? { ...now, tab } : now))}
              close={closePanel}
              openTerminal={openTerminal}
            />
          </>
        )}
      </div>
      {menu && (
        <ContextMenu
          label={menu.label ?? '파드 메뉴'}
          at={menu.at}
          items={menu.items}
          close={() => setMenu(null)}
        />
      )}
    </div>
  );
}
