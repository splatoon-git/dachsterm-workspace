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
import { KubePodPanel } from './KubePodPanel';
import { KubeTree, type PodAction } from './KubeTree';
import type { PodOverview, PodRef, ShellCheck } from './detailTypes';
import { chooseContainer, detailTab, rememberContainer, type PodPanelTarget } from './podPanel';
import { shellNote, shellTitle, type PodTerminalRequest } from './podShell';
import { stateNote, type SnapshotStore } from './polling';
import type { TreeView } from './tree';
import type { PodView } from './treePods';
import { readDetail } from './useKubeRead';

const WIDTH_KEY = 'dachsterm.kube.panelWidth';
const MIN_WIDTH = 280;
const MAX_WIDTH = 1400;
const DEFAULT_WIDTH = 520;

function readWidth() {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

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
}) {
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const [width, setWidth] = useState(readWidth);
  const opening = useRef(false);

  async function startShell(overview: PodOverview, container: string) {
    const target = { namespace: overview.namespace, pod: overview.name };
    const check = await call<ShellCheck>('kube_terminal_probe', {
      id: connectionId,
      kube,
      target,
      container,
    });
    if (check.kind !== 'ready') {
      setNotice(shellNote(check));
      return;
    }
    openTerminal({
      launch: { kind: 'podShell', connection: connectionId, kube, ...target, container },
      title: shellTitle(kube.context, overview.name),
      pod: { namespace: overview.namespace, name: overview.name },
      overview,
    });
  }

  /** Several ways to fail and each is one sentence by the tree, not a tab that opens and dies. */
  async function openShell(item: PodView, at: MenuPoint | undefined) {
    if (opening.current) return;
    opening.current = true;
    setNotice('');
    try {
      const pod = { namespace: item.pod.namespace, name: item.pod.name };
      const detail = await readDetail(connectionId, kube, pod, 'overview');
      if (detail.state.kind !== 'ready' || detail.data?.kind !== 'overview') {
        setNotice(`셸을 열 수 없습니다: ${stateNote(detail.state)}`);
        return;
      }
      const overview = detail.data;
      const chosen = chooseContainer(overview, session);
      if (chosen) {
        await startShell(overview, chosen);
        return;
      }
      setMenu({
        at: at ?? { x: 0, y: 0 },
        items: overview.containers.map((container) => ({
          label: container.name,
          run: () => {
            rememberContainer(session, overview, container.name);
            void startShell(overview, container.name).catch((e: unknown) =>
              setNotice(errorText(e)),
            );
          },
        })),
      });
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      opening.current = false;
    }
  }

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
        return void openShell(item, at);
      case 'menu':
        return setMenu({
          at: at ?? { x: 0, y: 0 },
          items: [
            { label: '로그', shortcut: 'Enter', run: () => handle('logs', item) },
            { label: '셸', shortcut: 's', run: () => handle('shell', item, at) },
            { label: '이벤트', shortcut: 'e', run: () => handle('events', item) },
            { label: '상세', run: () => handle('detail', item) },
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
          panelOpen={panel !== null}
          closePanel={closePanel}
          focusPod={focusPod}
          focusSignal={focusSignal}
        />
        {panel && (
          <>
            <ResizeHandle
              value={width}
              min={MIN_WIDTH}
              max={MAX_WIDTH}
              reverse
              onChange={(next) => {
                setWidth(next);
                try {
                  localStorage.setItem(WIDTH_KEY, String(next));
                } catch {
                  // The width is a convenience; a full or blocked store only forgets it.
                }
              }}
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
          label="파드 메뉴"
          at={menu.at}
          items={menu.items}
          close={() => setMenu(null)}
        />
      )}
    </div>
  );
}
