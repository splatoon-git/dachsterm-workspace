import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import type { PodRef } from './detailTypes';
import { IngressView } from './IngressView';
import { KubeAi } from './KubeAi';
import { KubeChanges } from './KubeChanges';
import { KubeDashboard } from './KubeDashboard';
import { KubeHeader } from './KubeHeader';
import { KubeProblems } from './KubeProblems';
import { KubeSetup } from './KubeSetup';
import { KubeTreeScreen, type PanelState } from './KubeTreeScreen';
import { LogBoard } from './LogBoard';
import { flowEntries, scopeEntry, type BoardScope } from './logBoardModel';
import { LogSearch } from './LogSearch';
import { OperateModeControl } from './OperateModeControl';
import type { SearchScope } from './logSearchModel';
import type { PathRow } from './ingressModel';
import type { PodTerminalRequest } from './podShell';
import { freshness } from './polling';
import { problemCount, problemSections } from './problems';
import { readLastScreen, writeLastScreen } from './screenPref';
import { initialTreeView } from './tree';
import type { TreeTarget } from './treeReveal';
import { useKubeIngress } from './useKubeIngress';
import { useKubeSnapshots } from './useKubeSnapshots';
import { useLogBoard } from './useLogBoard';
import { useLogSearch } from './useLogSearch';
import { useOperateMode } from './useOperateMode';
import { useAlertPref, useProblemAlerts } from './useProblemAlerts';
import { useWorkerWatch } from './useWorkerWatch';
import { WorkersContext } from './workerContext';
import {
  copyResultNote,
  finishesAfterRecheck,
  opensDirectly,
  settingsFrom,
  type DetectRequest,
  type Detection,
  type KubeCopyResult,
  type KubeDisplay,
  type KubeScreen,
} from './kubeModel';
import './kube.css';

export type { KubeCopyResult };

type Phase =
  | { name: 'detecting' }
  | { name: 'setup'; detection: Detection }
  /** `offline` says the saved cluster could not be reached when the tab opened. */
  | { name: 'open'; settings: KubeSettings; offline: boolean };

/**
 * The tab's header and the screen under it. The server terminal is a sibling that the pane shows
 * or hides, so its shell keeps running while this is on screen. Keyed by connection: a reconnect
 * detects again and types nothing.
 */
export function KubeWorkspace({
  connectionId,
  persist,
  session,
  sessionName,
  visible,
  focused,
  display,
  showTerminal,
  showWorkspace,
  copy,
  focusPod,
  openTerminal,
}: {
  connectionId: string;
  /** Saved only for a session opened as a Kubernetes session. */
  persist: boolean;
  /** The profile this tab belongs to, for the tree's saved folding. */
  session: string;
  /** Its name, for the title of an alert. The app owns this text and a cluster cannot change it. */
  sessionName: string;
  /** The tab is on screen; a split pane in a background tab is not. */
  visible: boolean;
  focused: boolean;
  display: Exclude<KubeDisplay, 'off'>;
  showTerminal: () => void;
  showWorkspace: () => void;
  copy: (command: string) => KubeCopyResult;
  focusPod: PodRef | null;
  openTerminal: (request: PodTerminalRequest) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ name: 'detecting' });
  const [screen, setScreen] = useState<KubeScreen>(() => readLastScreen(session));
  const [treeView, setTreeView] = useState(initialTreeView);
  const [panel, setPanel] = useState<PanelState>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const latest = useRef(0);
  const logSearch = useLogSearch(connectionId);
  const [searchFocus, setSearchFocus] = useState(0);
  const [ingressFilter, setIngressFilter] = useState('');

  const finish = useCallback(
    async (settings: KubeSettings) => {
      if (persist) await call('kube_save', { id: connectionId, kube: settings });
      setNote('');
      setPhase({ name: 'open', settings, offline: false });
    },
    [connectionId, persist],
  );

  const detect = useCallback(
    (request: DetectRequest, context: string | null) =>
      call<Detection>('kube_detect', { id: connectionId, request, context }),
    [connectionId],
  );

  /** Only the newest request may change the screen. */
  const settle = useCallback(
    (pending: Promise<Detection>, recheck: boolean) => {
      const ticket = ++latest.current;
      void pending
        .then((detection) => {
          if (ticket !== latest.current) return;
          if (opensDirectly(detection) && detection.saved) {
            setPhase({
              name: 'open',
              settings: detection.saved,
              offline: detection.state.kind === 'unreachable',
            });
          } else if (recheck && finishesAfterRecheck(detection)) {
            return finish(settingsFrom(detection, detection.context, ''));
          } else {
            setPhase({ name: 'setup', detection });
          }
        })
        .catch((e: unknown) => {
          if (ticket === latest.current) setError(errorText(e));
        })
        .finally(() => {
          if (ticket === latest.current) setBusy(false);
        });
    },
    [finish],
  );

  useEffect(() => {
    settle(detect({ mode: 'saved' }, null), false);
    const tickets = latest;
    return () => {
      tickets.current++;
    };
  }, [detect, settle]);

  const run = (request: DetectRequest, context: string | null, recheck: boolean) => {
    setBusy(true);
    setError('');
    settle(detect(request, context), recheck);
  };

  const recheck = (request: DetectRequest) => {
    setNote('');
    showWorkspace();
    run(request, null, true);
  };

  const openScreen = useCallback(
    (id: KubeScreen) => {
      setScreen(id);
      writeLastScreen(session, id);
      showWorkspace();
    },
    [session, showWorkspace],
  );

  const reveal = useCallback(
    (target: TreeTarget) => {
      setTreeView((now) => ({ ...now, reveal: target }));
      openScreen('tree');
    },
    [openScreen],
  );

  const setSearchForm = logSearch.setForm;
  const searchLogs = useCallback(
    (scope: SearchScope) => {
      setSearchForm((now) => ({ ...now, scope }));
      setSearchFocus((n) => n + 1);
      openScreen('logs');
    },
    [setSearchForm, openScreen],
  );

  const openRuntime = useCallback(
    (pod: PodRef) => {
      setPanel({ namespace: pod.namespace, name: pod.name, tab: 'runtime', problem: false });
      openScreen('tree');
    },
    [openScreen],
  );

  const searchController = useCallback(
    (keyword: string) => {
      setSearchForm((now) => ({
        ...now,
        scope: { kind: 'controller', value: '' },
        query: keyword,
      }));
      setSearchFocus((n) => n + 1);
      openScreen('logs');
    },
    [setSearchForm, openScreen],
  );

  const openIngress = useCallback(
    (host: string) => {
      setIngressFilter(host);
      openScreen('ingress');
    },
    [openScreen],
  );

  const copyToTerminal = (command: string) => setNote(copyResultNote(copy(command)));

  const detection = phase.name === 'setup' ? phase.detection : null;
  const settingUp = phase.name !== 'open';
  const operate = useOperateMode(connectionId, phase.name === 'open');
  const settings = phase.name === 'open' ? phase.settings : null;
  const onScreen = visible && display === 'workspace';
  const [alerts, setAlerts] = useAlertPref(session);
  const { store, history, issues, now } = useKubeSnapshots(
    connectionId,
    settings,
    onScreen,
    alerts,
  );
  const alertError = useProblemAlerts(issues, alerts, sessionName, onScreen);
  const sections = useMemo(() => problemSections(store), [store]);
  const workers = useWorkerWatch(connectionId, settings, onScreen, store.pods.data, session);
  // Only the screens that use it: the costliest poll here (KV.8). The board needs controller names.
  const ingress = useKubeIngress(
    connectionId,
    settings,
    onScreen && (screen === 'ingress' || screen === 'dashboard' || screen === 'board'),
  );
  const board = useLogBoard(
    connectionId,
    settings,
    store.pods.data,
    store.services.data,
    ingress.controllers,
  );
  const { watch: watchEntries } = board;
  const watchLogs = useCallback(
    (scope: BoardScope) => {
      watchEntries([scopeEntry(scope)]);
      openScreen('board');
    },
    [watchEntries, openScreen],
  );
  const openFlow = useCallback(
    (rows: PathRow[]) => {
      watchEntries(flowEntries(rows), true);
      openScreen('board');
    },
    [watchEntries, openScreen],
  );
  const fresh = freshness(store, now);
  const warning =
    fresh.warning ?? (phase.name === 'open' && phase.offline ? '클러스터 연결 불가' : null);
  return (
    <div className={`kube-workspace ${display === 'terminal' ? 'on-terminal' : ''}`}>
      <KubeHeader
        screen={screen}
        display={display}
        openScreen={openScreen}
        showTerminal={showTerminal}
        settings={settings}
        mode={settings && <OperateModeControl control={operate} context={settings.context} />}
        age={fresh.age}
        warning={warning}
        liveLogs={board.phase === 'live'}
        problems={problemCount(sections)}
        aiAvailable={workers.ai.available}
        setup={settingUp ? { note, busy, recheck: () => recheck({ mode: 'scan' }) } : null}
      />
      {display === 'workspace' && (
        <WorkersContext.Provider value={workers}>
          <div className="kube-body">
            {phase.name === 'detecting' && (
              <p className="kube-detecting">클러스터를 확인하는 중…</p>
            )}
            {detection && (
              <KubeSetup
                detection={detection}
                busy={busy}
                error={error}
                note={note}
                recheck={recheck}
                chooseContext={(context) =>
                  run(
                    {
                      mode: 'manual',
                      kubectl: detection.kubectl,
                      kubeconfig: detection.kubeconfig,
                    },
                    context,
                    false,
                  )
                }
                start={(context, namespace) => {
                  setBusy(true);
                  finish(settingsFrom(detection, context, namespace))
                    .catch((e: unknown) => setError(errorText(e)))
                    .finally(() => setBusy(false));
                }}
                copy={copyToTerminal}
              />
            )}
            {phase.name === 'open' && screen === 'tree' && (
              <KubeTreeScreen
                store={store}
                session={session}
                focused={focused}
                view={treeView}
                setView={setTreeView}
                connectionId={connectionId}
                kube={phase.settings}
                operate={operate}
                panel={panel}
                setPanel={setPanel}
                focusPod={focusPod}
                openTerminal={openTerminal}
                searchLogs={searchLogs}
                watchLogs={watchLogs}
              />
            )}
            {phase.name === 'open' && screen === 'board' && (
              <LogBoard board={board} store={store} controllers={ingress.controllers} />
            )}
            {phase.name === 'open' && screen === 'dashboard' && (
              <KubeDashboard
                store={store}
                history={history}
                namespace={phase.settings.namespace}
                reveal={reveal}
                searchLogs={searchLogs}
                openRuntime={openRuntime}
                ingress={ingress}
                openIngress={openIngress}
              />
            )}
            {phase.name === 'open' && screen === 'problems' && (
              <KubeProblems
                sections={sections}
                store={store}
                reveal={reveal}
                alerts={alerts}
                setAlerts={setAlerts}
                alertError={alertError}
              />
            )}
            {phase.name === 'open' && screen === 'changes' && (
              <KubeChanges changes={issues.changes} reveal={reveal} />
            )}
            {phase.name === 'open' && screen === 'logs' && (
              <LogSearch
                search={logSearch}
                store={store}
                connectionId={connectionId}
                kube={phase.settings}
                session={session}
                focusRequest={searchFocus}
                openTerminal={openTerminal}
                controllers={ingress.controllers}
              />
            )}
            {phase.name === 'open' && screen === 'ingress' && (
              <IngressView
                data={ingress}
                store={store}
                filter={ingressFilter}
                setFilter={setIngressFilter}
                reveal={reveal}
                searchController={searchController}
                openFlow={openFlow}
              />
            )}
            {phase.name === 'open' && screen === 'ai' && <KubeAi openRuntime={openRuntime} />}
            {phase.name === 'detecting' && error && <p role="alert">{error}</p>}
          </div>
        </WorkersContext.Provider>
      )}
    </div>
  );
}
