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
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import { planDelete, blockedReason, type ActionPlan } from './actionModel';
import { KubeActionDialog } from './KubeActionDialog';
import { KubePodPanel } from './KubePodPanel';
import { KubeTree, type PodAction } from './KubeTree';
import type { PodRef } from './detailTypes';
import type { BoardScope } from './logBoardModel';
import type { SearchScope } from './logSearchModel';
import { detailTab, type PodPanelTarget } from './podPanel';
import type { PodTerminalRequest } from './podShell';
import type { SnapshotStore } from './polling';
import type { TreeRow, TreeView } from './tree';
import { actionItem, treeRowMenu } from './treeRowMenu';
import { treeText, type ShownTree } from './treeText';
import type { PodView } from './treePods';
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  panelWidthStyle,
  usePanelWidth,
} from './usePanelWidth';
import type { OperateControl } from './useOperateMode';
import { usePodShell } from './usePodShell';
import { useWorkers } from './workerContext';

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
  operate,
  panel,
  setPanel,
  focusPod,
  openTerminal,
  searchLogs,
  watchLogs,
}: {
  store: SnapshotStore;
  session: string;
  focused: boolean;
  view: TreeView;
  setView: Dispatch<SetStateAction<TreeView>>;
  connectionId: string;
  kube: KubeSettings;
  operate: OperateControl;
  panel: PanelState;
  setPanel: Dispatch<SetStateAction<PanelState>>;
  focusPod: PodRef | null;
  openTerminal: (request: PodTerminalRequest) => void;
  searchLogs: (scope: SearchScope) => void;
  watchLogs: (scope: BoardScope) => void;
}) {
  const [notice, setNotice] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState<(MenuRequest & { label?: string }) | null>(null);
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const { width, change } = usePanelWidth();
  const shown = useRef<ShownTree | null>(null);
  const workers = useWorkers();
  const openShell = usePodShell({
    connectionId,
    kube,
    session,
    openTerminal,
    notify: setNotice,
    openMenu: setMenu,
  });

  const blocked = blockedReason(operate.mode);

  const showPanel = (item: PodView, tab: PodPanelTarget['tab']) => {
    setNotice('');
    setPanel({ namespace: item.pod.namespace, name: item.pod.name, tab, problem: item.problem });
  };

  const copyTree = () => {
    if (!shown.current) return;
    const scope = { ...view, context: kube.context, namespace: kube.namespace };
    const text = treeText(shown.current, scope, workers.cells);
    call('clipboard_write_text', { text }).then(
      () => setNotice('보이는 트리를 복사했습니다.'),
      (e: unknown) => setNotice(errorText(e)),
    );
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
            { label: '런타임', run: () => showPanel(item, 'runtime') },
            {
              label: '실시간 로그에 추가',
              separated: true,
              run: () =>
                watchLogs({ kind: 'pod', value: `${item.pod.namespace}/${item.pod.name}` }),
            },
            {
              label: '로그 검색',
              run: () =>
                searchLogs({ kind: 'pod', value: `${item.pod.namespace}/${item.pod.name}` }),
            },
            { label: '보이는 트리 복사', separated: true, run: copyTree },
            actionItem(planDelete(item.pod), blocked, setPlan),
          ],
        });
    }
  };
  const rowMenu = (row: TreeRow, at?: MenuPoint): void => {
    const nodes = store.nodes.data;
    const found = treeRowMenu(row, {
      nodes,
      blocked,
      ask: setPlan,
      watchLogs,
      searchLogs,
      copyTree,
    });
    if (found) setMenu({ ...found, at: at ?? { x: 0, y: 0 } });
  };
  // The tree is memoized and redraws only for new data, so it gets one function for its lifetime.
  const latest = useRef({ handle, rowMenu });
  useLayoutEffect(() => {
    latest.current = { handle, rowMenu };
  });
  const onPod = useCallback(
    (action: PodAction, item: PodView, at?: MenuPoint) => latest.current.handle(action, item, at),
    [],
  );
  const onRow = useCallback((row: TreeRow, at?: MenuPoint) => latest.current.rowMenu(row, at), []);
  const closePanel = useCallback(() => {
    setPanel(null);
    setExpanded(false);
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
      <div className={`kube-split ${expanded && panel ? 'expanded' : ''}`}>
        <KubeTree
          store={store}
          session={session}
          focused={focused}
          view={view}
          setView={setView}
          onPod={onPod}
          onRow={onRow}
          panelOpen={panel !== null}
          closePanel={closePanel}
          focusPod={focusPod}
          focusSignal={focusSignal}
          shown={shown}
        />
        {panel && (
          <>
            <ResizeHandle
              value={width}
              min={PANEL_MIN_WIDTH}
              max={PANEL_MAX_WIDTH}
              reverse
              onChange={change}
              onReset={() => change(PANEL_DEFAULT_WIDTH)}
              label="로그 패널 크기"
            />
            <KubePodPanel
              key={`${panel.namespace}/${panel.name}`}
              connectionId={connectionId}
              kube={kube}
              session={session}
              target={panel}
              store={store}
              style={expanded ? undefined : { width: panelWidthStyle(width) }}
              setTab={(tab) => setPanel((now) => (now ? { ...now, tab } : now))}
              close={closePanel}
              openTerminal={openTerminal}
              expanded={expanded}
              toggleExpanded={() => setExpanded((now) => !now)}
              watchPod={(pod) => watchLogs({ kind: 'pod', value: `${pod.namespace}/${pod.name}` })}
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
      {plan && (
        <KubeActionDialog
          plan={plan}
          connectionId={connectionId}
          context={kube.context}
          close={() => {
            setPlan(null);
            operate.reload();
          }}
          done={(finished) => {
            setPlan(null);
            setNotice(finished.done);
            operate.reload();
          }}
        />
      )}
    </div>
  );
}
