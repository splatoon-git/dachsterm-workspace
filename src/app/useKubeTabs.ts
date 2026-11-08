import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { call, blankProfile, type PodTerminalLaunch } from '../lib/ipc';
import type { Detail, PodOverview } from '../features/kube/detailTypes';
import {
  endNotice,
  lookupAfterShell,
  replacementPod,
  shellEndAction,
  shellTitle,
  type PodTerminalRequest,
  type ShellLookup,
} from '../features/kube/podShell';
import type { Snapshot } from '../features/kube/snapshotTypes';
import { TerminalSession, type KubeLaunch } from '../features/terminal/session';
import type { ThemeDefinition } from '../themes/contract';
import type { Workspace } from './useWorkspaceLayout';
import { tabKey, type TabRef } from './workspaceLayout';

const refOf = (session: TerminalSession): TabRef => ({ kind: 'session', tabId: session.tabId });
const ended = (status: string): status is 'closed' | 'error' =>
  status === 'closed' || status === 'error';

type ShellTab = {
  parent: TerminalSession;
  /** The pod as it was when the shell opened, to compare against when the shell ends. */
  overview: PodOverview | null;
  container: string;
  lastLookup: ShellLookup | null;
  connectedAt: number;
  handled: string | null;
};

/**
 * Pod shells and followed logs, opened on the SSH connection of the tab they came from. A shell's
 * end decides for itself: `exit` closes it and returns to the pod, a pod that went away asks.
 */
export function useKubeTabs({
  workspace,
  theme,
  tabs,
  setTabs,
  closeTab,
}: {
  workspace: Workspace;
  theme: ThemeDefinition;
  tabs: TerminalSession[];
  setTabs: Dispatch<SetStateAction<TerminalSession[]>>;
  closeTab: (session: TerminalSession) => void;
}) {
  const latest = useRef({ workspace, tabs, closeTab });
  const shells = useRef(new Map<string, ShellTab>());
  useEffect(() => {
    latest.current = { workspace, tabs, closeTab };
    for (const tabId of shells.current.keys())
      if (!tabs.some((tab) => tab.tabId === tabId)) shells.current.delete(tabId);
  });

  function start(launch: KubeLaunch, name: string, host: string) {
    const profile = { ...blankProfile(), name, host };
    const session = new TerminalSession(profile, theme, () => {}, undefined, launch);
    setTabs((previous) => [...previous, session]);
    latest.current.workspace.open(refOf(session));
    return session;
  }

  /** The tree's cursor goes back to the pod, unless the user has already moved to another tab. */
  function backToTree(session: TerminalSession, shell: ShellTab) {
    const { workspace: now, closeTab: close } = latest.current;
    const showing = now.focusedGroup.active === tabKey(refOf(session));
    const launch = session.podtree;
    close(session);
    if (!showing || !launch || launch.kind === 'script') return;
    if (!latest.current.tabs.includes(shell.parent)) return;
    now.open(refOf(shell.parent));
    shell.parent.view.set({
      kubeTerminal: false,
      kubeFocus: { namespace: launch.namespace, name: launch.pod },
    });
  }

  /** `kube_detail` rejects once the SSH connection is gone: how a tab learns its parent ended. */
  const askPod = (launch: PodTerminalLaunch) =>
    call<Detail>('kube_detail', {
      id: launch.connection,
      kube: launch.kube,
      target: { namespace: launch.namespace, pod: launch.pod },
      kind: 'overview',
    }).catch(() => null);

  /** A followed log only needs cleaning up: its text is still worth reading when the pod goes. */
  function watchLogs(session: TerminalSession, launch: PodTerminalLaunch) {
    const seen = new Set<string>();
    session.subscribe(() => {
      if (!ended(session.snapshot().status) || seen.has(session.connectionId)) return;
      seen.add(session.connectionId);
      void askPod(launch).then((detail) => {
        if (detail === null && !session.disposed) latest.current.closeTab(session);
      });
    });
  }

  async function settle(session: TerminalSession, shell: ShellTab, status: 'closed' | 'error') {
    const launch = session.podtree;
    if (!launch || launch.kind !== 'podShell') return;
    const ranMs = shell.connectedAt ? Date.now() - shell.connectedAt : 0;
    const detail = await askPod(launch);
    const lookup = lookupAfterShell(shell.overview, launch.container, detail);
    shell.lastLookup = lookup;
    const action = shellEndAction(status, lookup, ranMs);
    if (session.disposed) return;
    if (action === 'close') {
      if (lookup === 'noConnection') latest.current.closeTab(session);
      else backToTree(session, shell);
    } else if (action === 'ask') {
      const hasWorkload = lookup === 'restarted' || !!shell.overview?.ownerKind;
      session.notice(endNotice(lookup, hasWorkload));
    }
  }

  function watch(session: TerminalSession, shell: ShellTab) {
    session.subscribe(() => {
      const { status } = session.snapshot();
      if (status === 'connected' && !shell.connectedAt) shell.connectedAt = Date.now();
      if (!ended(status) || shell.handled === session.connectionId) return;
      shell.handled = session.connectionId;
      void settle(session, shell, status);
    });
  }

  function open(parent: TerminalSession, request: PodTerminalRequest) {
    const host = `${request.pod.namespace}/${request.pod.name}`;
    const session = start(request.launch, request.title, host);
    if (request.launch.kind === 'podShell') {
      const shell: ShellTab = {
        parent,
        overview: request.overview,
        container: request.launch.container,
        lastLookup: null,
        connectedAt: 0,
        handled: null,
      };
      shells.current.set(session.tabId, shell);
      watch(session, shell);
    } else {
      watchLogs(session, request.launch);
    }
    void session.connect(null);
  }

  /** The workload's new pod, or the same pod when only its container was replaced. */
  async function nextTarget(launch: PodTerminalLaunch, shell: ShellTab) {
    if (shell.lastLookup === 'restarted' || shell.lastLookup === 'same' || !shell.overview)
      return { pod: launch.pod, overview: shell.overview };
    const snapshot = await call<Snapshot>('kube_snapshot', {
      id: launch.connection,
      kube: launch.kube,
      kind: 'pods',
    });
    const pods = snapshot.data?.kind === 'pods' ? snapshot.data.items : [];
    const next = replacementPod(pods, shell.overview);
    if (!next) return null;
    const detail = await call<Detail>('kube_detail', {
      id: launch.connection,
      kube: launch.kube,
      target: { namespace: next.namespace, pod: next.name },
      kind: 'overview',
    });
    return {
      pod: next.name,
      overview: detail.data?.kind === 'overview' ? detail.data : null,
    };
  }

  /** Never runs anything in the new shell: `reconnect` only says so on screen. */
  async function reconnect(session: TerminalSession) {
    const launch = session.podtree;
    if (!launch || launch.kind === 'script') return;
    const shell = shells.current.get(session.tabId);
    if (!shell || launch.kind !== 'podShell') {
      void session.reconnect(null, session.profile);
      return;
    }
    if (shell.parent.snapshot().status !== 'connected') {
      session.notice('이 탭을 연 서버 연결이 끊겼습니다. 서버에 다시 접속한 뒤 파드를 여세요.');
      return;
    }
    try {
      const connection = shell.parent.connectionId;
      const here = { ...launch, connection };
      const target = await nextTarget(here, shell);
      if (!target) {
        session.notice('같은 워크로드의 준비된 새 파드가 아직 없습니다. 잠시 뒤 다시 누르세요.');
        return;
      }
      const container =
        target.overview?.containers.find((c) => c.name === launch.container)?.name ??
        target.overview?.containers[0]?.name ??
        launch.container;
      session.podtree = { ...here, pod: target.pod, container };
      shell.overview = target.overview;
      shell.container = container;
      shell.connectedAt = 0;
      shell.handled = null;
      const name = shellTitle(launch.kube.context, target.pod);
      void session.reconnect(null, { ...session.profile, name });
    } catch {
      session.notice('새 파드를 찾지 못했습니다. 잠시 뒤 다시 누르세요.');
    }
  }

  return { start, open, reconnect };
}
