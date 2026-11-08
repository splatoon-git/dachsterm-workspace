import type { PodTerminalLaunch } from '../../lib/ipc';
import type { Detail, PodOverview, ShellCheck } from './detailTypes';
import { stateNote } from './polling';
import type { KubePod } from './snapshotTypes';
import { ownerOf } from './tree';

/** What a tab asks the app to open. `overview` is what the shell's end is later compared with. */
export type PodTerminalRequest = {
  launch: PodTerminalLaunch;
  title: string;
  pod: { namespace: string; name: string };
  overview: PodOverview | null;
};

export const shellTitle = (context: string, pod: string) => `${context} · ${pod}`;

export function shellNote(check: ShellCheck): string {
  switch (check.kind) {
    case 'ready':
      return '';
    case 'noShell':
      return '이 컨테이너 이미지에는 셸(sh)이 없어 열 수 없습니다. 로그와 이벤트로 확인하세요.';
    case 'notRunning':
      return '컨테이너가 실행 중이 아니어서 셸을 열 수 없습니다. 장애 원인에서 종료 사유를 확인하세요.';
    case 'blocked':
      if (check.state.kind === 'channelLimit')
        return '서버의 동시 세션 한도(MaxSessions)에 걸려 셸을 열 수 없습니다. 다른 탭이나 파일 전송을 줄이고 다시 시도하세요.';
      if (check.state.kind === 'forbidden')
        return '이 계정은 이 파드에 exec 권한(pods/exec)이 없습니다.';
      return `셸을 열 수 없습니다: ${stateNote(check.state)}`;
  }
}

/** How the pod stands once its shell has ended. */
export type ShellLookup = 'same' | 'restarted' | 'gone' | 'unknown' | 'noConnection';

/**
 * `identity` is the pod when the shell opened; `detail` is `null` when even asking failed, which
 * is what happens once the SSH connection the tab was added to has ended.
 */
export function lookupAfterShell(
  identity: PodOverview | null,
  container: string,
  detail: Detail | null,
): ShellLookup {
  if (detail === null) return 'noConnection';
  if (detail.state.kind === 'notFound') return 'gone';
  if (detail.state.kind !== 'ready' || detail.data?.kind !== 'overview' || !identity)
    return 'unknown';
  const now = detail.data;
  if (now.deleting || now.uid !== identity.uid) return 'gone';
  const id = (pod: PodOverview) => pod.containers.find((c) => c.name === container)?.containerId;
  return id(now) === id(identity) ? 'same' : 'restarted';
}

/** Under this a failure means the shell never really started, so the message stays on screen. */
const SHORT_RUN_MS = 2000;

export type ShellEnd = 'close' | 'keep' | 'ask';

/** `exit` closes the tab whatever its exit code; a pod that went away asks first. */
export function shellEndAction(
  status: 'closed' | 'error',
  lookup: ShellLookup,
  ranMs: number,
): ShellEnd {
  if (lookup === 'noConnection') return 'close';
  if (lookup === 'gone' || lookup === 'restarted') return 'ask';
  if (status === 'closed') return 'close';
  if (lookup === 'same' && ranMs >= SHORT_RUN_MS) return 'close';
  return 'keep';
}

export function endNotice(lookup: ShellLookup, hasWorkload: boolean): string {
  if (lookup === 'restarted')
    return '컨테이너가 다시 시작되어 셸이 끊겼습니다. 재접속을 누르면 새 셸을 엽니다. 이전 명령은 다시 실행하지 않습니다.';
  if (!hasWorkload)
    return '파드가 사라졌습니다. 소유 워크로드가 없어 같은 워크로드의 새 파드로 접속할 수 없습니다.';
  return '파드가 사라졌습니다. 재접속을 누르면 같은 워크로드의 새 파드로 접속합니다. 이전 명령은 다시 실행하지 않습니다.';
}

type OldPod = Pick<
  PodOverview,
  'namespace' | 'name' | 'created' | 'ownerKind' | 'ownerName' | 'labels'
>;

/** The newest ready pod of the same workload. A StatefulSet's new pod keeps the old name. */
export function replacementPod(pods: KubePod[], old: OldPod): KubePod | null {
  const owner = ownerOf(old);
  if (!owner) return null;
  const sameWorkload = (pod: KubePod) => {
    const found = ownerOf(pod);
    return found?.kind === owner.kind && found.name === owner.name;
  };
  const candidates = pods.filter(
    (pod) =>
      pod.namespace === old.namespace &&
      sameWorkload(pod) &&
      !pod.deleting &&
      pod.phase === 'Running' &&
      pod.containers.length > 0 &&
      pod.containers.every((c) => c.ready) &&
      !(pod.name === old.name && pod.created === old.created),
  );
  return candidates.sort((a, b) => b.created.localeCompare(a.created))[0] ?? null;
}
