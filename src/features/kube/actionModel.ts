import type { KubeNode, KubePod } from './snapshotTypes';
import { ownerOf } from './tree';

/** Mirrors `OperateMode` in `kube/action.rs`, plus the two states before an answer is on screen. */
export type OperateMode = 'on' | 'off' | 'unavailable' | 'checking' | 'failed';

/** Mirrors `RolloutKind` in `kube/action.rs`. */
export type RolloutKind = 'deployment' | 'statefulSet' | 'daemonSet';
const rolloutKinds: Record<string, RolloutKind> = {
  Deployment: 'deployment',
  StatefulSet: 'statefulSet',
  DaemonSet: 'daemonSet',
};

/** Mirrors `Action` in `kube/action.rs`. */
export type KubeAction =
  | { kind: 'deletePod'; namespace: string; pod: string }
  | { kind: 'rolloutRestart'; namespace: string; workload: RolloutKind; name: string }
  | { kind: 'cordon'; node: string }
  | { kind: 'uncordon'; node: string };

/** Everything the confirmation shows, worked out before the user is asked. */
export type ActionPlan = {
  action: KubeAction;
  title: string;
  confirm: string;
  namespace: string;
  target: string;
  impact: string;
  /** Nothing brings it back: the confirmation says so more loudly. */
  permanent: boolean;
  done: string;
};

/** Why the write items are disabled; empty when they are not. */
export function blockedReason(mode: OperateMode): string {
  switch (mode) {
    case 'on':
      return '';
    case 'off':
      return '조회 모드에서는 쓸 수 없습니다. 상단의 조회 모드를 눌러 운영 모드로 바꾸세요.';
    case 'unavailable':
      return '탭 메뉴로 연 화면은 제어할 수 없습니다. 쿠버네티스 세션으로 접속하세요.';
    case 'checking':
      return '운영 모드를 확인하는 중입니다.';
    case 'failed':
      return '운영 모드를 읽지 못했습니다. 탭을 다시 여세요.';
  }
}

function deleteImpact(pod: KubePod): { impact: string; permanent: boolean } {
  const owner = ownerOf(pod);
  if (!owner) {
    return { impact: '소유 워크로드가 없어 삭제하면 복구되지 않습니다.', permanent: true };
  }
  const name = `${owner.kind}/${owner.name}`;
  if (owner.kind === 'Node')
    return {
      impact: `${name}의 정적 파드입니다. API의 미러 파드만 지워지고 kubelet이 다시 만듭니다.`,
      permanent: false,
    };
  if (owner.kind === 'Job')
    return {
      impact: `${name}이(가) 아직 끝나지 않았다면 새 파드를 만들고, 끝났다면 다시 만들지 않습니다.`,
      permanent: false,
    };
  return {
    impact: `${name}이(가) 새 파드를 다시 만듭니다. 처리 중인 요청은 끊길 수 있습니다.`,
    permanent: false,
  };
}

export function planDelete(pod: KubePod): ActionPlan {
  const target = `pod/${pod.name}`;
  return {
    action: { kind: 'deletePod', namespace: pod.namespace, pod: pod.name },
    title: '파드 삭제',
    confirm: '삭제',
    namespace: pod.namespace,
    target,
    ...deleteImpact(pod),
    done: `${target} 삭제를 요청했습니다. 결과는 트리에서 확인하세요.`,
  };
}

export type Rollout = { namespace: string; kind: string; workload: RolloutKind; name: string };

/** `ns:<namespace>/wl:<Kind>/<name>` from `workloadGroupId`. Other owners have no rollout. */
export function rolloutOfGroup(id: string): Rollout | null {
  const found = /^ns:([^/]+)\/wl:([^/]+)\/([^/]+)$/.exec(id);
  if (!found) return null;
  const [, namespace, kind, name] = found;
  const workload = rolloutKinds[kind];
  return workload ? { namespace, kind, workload, name } : null;
}

export function planRollout(rollout: Rollout, pods: number): ActionPlan {
  const { namespace, kind, workload, name } = rollout;
  const target = `${kind}/${name}`;
  return {
    action: { kind: 'rolloutRestart', namespace, workload, name },
    title: '롤아웃 재시작',
    confirm: '재시작',
    namespace,
    target,
    impact: `파드 ${pods}개를 ${kind}의 전략에 맞춰 차례로 새 파드로 바꿉니다.`,
    permanent: false,
    done: `${target} 재시작을 요청했습니다. 결과는 트리에서 확인하세요.`,
  };
}

/** The group a node is grouped by. Below it the ids go on with `/ns:`, and those are not nodes. */
export const nodeNameOfGroup = (id: string) => /^node:([^/]+)$/.exec(id)?.[1] ?? null;

/** Each node offers the one change that would do something. */
export function planNode(node: Pick<KubeNode, 'name' | 'unschedulable'>): ActionPlan {
  const target = `node/${node.name}`;
  const base = { namespace: '클러스터 전체', target, permanent: false };
  return node.unschedulable
    ? {
        ...base,
        action: { kind: 'uncordon', node: node.name },
        title: 'Uncordon',
        confirm: 'Uncordon',
        impact: '이 노드에 새 파드를 다시 배치할 수 있게 됩니다.',
        done: `${target} uncordon을 요청했습니다. 결과는 트리에서 확인하세요.`,
      }
    : {
        ...base,
        action: { kind: 'cordon', node: node.name },
        title: 'Cordon',
        confirm: 'Cordon',
        impact: '새 파드가 이 노드에 배치되지 않습니다. 실행 중인 파드는 그대로 남습니다.',
        done: `${target} cordon을 요청했습니다. 결과는 트리에서 확인하세요.`,
      };
}
