import { useRef } from 'react';
import type { MenuPoint, MenuRequest } from '../../components/ContextMenu';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import type { PodOverview, PodRef, ShellCheck } from './detailTypes';
import { chooseContainer, rememberContainer } from './podPanel';
import { shellNote, shellTitle, type PodTerminalRequest } from './podShell';
import { stateNote } from './polling';
import { readDetail } from './useKubeRead';

/**
 * Opens a pod shell from wherever a pod is listed. Each way to fail is one sentence beside the
 * list, not a tab that opens and dies. `container` is for when the caller already knows which.
 */
export function usePodShell({
  connectionId,
  kube,
  session,
  openTerminal,
  notify,
  openMenu,
}: {
  connectionId: string;
  kube: KubeSettings;
  session: string;
  openTerminal: (request: PodTerminalRequest) => void;
  notify: (note: string) => void;
  openMenu: (menu: MenuRequest) => void;
}) {
  const opening = useRef(false);

  async function start(overview: PodOverview, container: string) {
    const target = { namespace: overview.namespace, pod: overview.name };
    const check = await call<ShellCheck>('kube_terminal_probe', {
      id: connectionId,
      kube,
      target,
      container,
    });
    if (check.kind !== 'ready') {
      notify(shellNote(check));
      return;
    }
    openTerminal({
      launch: { kind: 'podShell', connection: connectionId, kube, ...target, container },
      title: shellTitle(kube.context, overview.name),
      pod: { namespace: overview.namespace, name: overview.name },
      overview,
    });
  }

  return async function openShell(pod: PodRef, at?: MenuPoint, container?: string) {
    if (opening.current) return;
    opening.current = true;
    notify('');
    try {
      const detail = await readDetail(connectionId, kube, pod, 'overview');
      if (detail.state.kind !== 'ready' || detail.data?.kind !== 'overview') {
        notify(`셸을 열 수 없습니다: ${stateNote(detail.state)}`);
        return;
      }
      const overview = detail.data;
      const known = overview.containers.some((item) => item.name === container);
      const chosen = known ? container : chooseContainer(overview, session);
      if (chosen) {
        await start(overview, chosen);
        return;
      }
      openMenu({
        at: at ?? { x: 0, y: 0 },
        items: overview.containers.map((item) => ({
          label: item.name,
          run: () => {
            rememberContainer(session, overview, item.name);
            void start(overview, item.name).catch((e: unknown) => notify(errorText(e)));
          },
        })),
      });
    } catch (e) {
      notify(errorText(e));
    } finally {
      opening.current = false;
    }
  };
}
