import type { KubeSettings } from '../../lib/ipc';
import { stateNote } from './polling';

/** Mirrors `KubeState` in `kube/state.rs`, which is the only reader of kubectl's output. */
export type KubeState =
  | { kind: 'ready' }
  | { kind: 'kubectlMissing' }
  | { kind: 'configMissing' }
  | { kind: 'configUnreadable' }
  | { kind: 'authFailed' }
  | { kind: 'authPluginFailed'; message: string }
  | { kind: 'forbidden' }
  | { kind: 'contextMissing' }
  | { kind: 'unreachable' }
  | { kind: 'channelLimit' }
  | { kind: 'notFound' }
  | { kind: 'metricsMissing' }
  | { kind: 'timedOut' }
  | { kind: 'tooLarge' }
  | { kind: 'unknown'; message: string };

export type Detection = {
  state: KubeState;
  kubectl: string;
  kubeconfig: string;
  context: string;
  contexts: string[];
  namespaces: string[];
  namespacesForbidden: boolean;
  copyCommand?: string | null;
  saved?: KubeSettings | null;
};

export type DetectRequest =
  { mode: 'saved' } | { mode: 'scan' } | { mode: 'manual'; kubectl: string; kubeconfig: string };

/** What the tab shows while a session has no working settings yet. */
export type SetupStep = 'choose' | 'copy' | 'manual' | 'retry';

export function setupStep(detection: Detection, local = false): SetupStep {
  switch (detection.state.kind) {
    case 'ready':
    case 'forbidden':
    case 'unreachable':
    case 'contextMissing':
      return detection.contexts.length ? 'choose' : 'manual';
    // Making a copy with sudo is for a server. Here the user can only point at another file.
    case 'configUnreadable':
      return local ? 'manual' : 'copy';
    case 'authFailed':
      return local ? 'retry' : 'copy';
    case 'kubectlMissing':
    case 'configMissing':
      return 'manual';
    case 'authPluginFailed':
    case 'channelLimit':
    case 'notFound':
    case 'metricsMissing':
    case 'timedOut':
    case 'tooLarge':
    case 'unknown':
      return 'retry';
  }
}

/** A saved session opens at once. A cluster that is down right now does not need setting up again. */
export const opensDirectly = (detection: Detection) =>
  !!detection.saved && ['ready', 'unreachable'].includes(detection.state.kind);

/**
 * After the user made a copy and asked to check again, a single cluster leaves nothing to choose.
 * Several contexts still go through the choice.
 */
export const finishesAfterRecheck = (detection: Detection) =>
  detection.state.kind === 'ready' && detection.contexts.length === 1;

export type Guide = { title: string; body: string };

export function setupGuide(state: KubeState, local = false): Guide | null {
  switch (state.kind) {
    case 'ready':
      return null;
    case 'kubectlMissing':
      return {
        title: 'kubectl을 찾을 수 없습니다',
        body: local
          ? 'PATH와 잘 알려진 위치에서 찾지 못했습니다. kubectl 실행 파일의 전체 경로를 입력하세요.'
          : '셸 환경과 잘 알려진 위치에서 찾지 못했습니다. 이 서버에서 실행할 명령을 직접 입력하세요.',
      };
    case 'configMissing':
      return {
        title: '쿠버네티스 설정 파일을 찾을 수 없습니다',
        body: local
          ? '이 컴퓨터의 kubeconfig 경로를 입력하세요. 내용은 앱으로 가져오지 않습니다.'
          : 'kubeconfig의 서버 경로를 입력하세요. 내용은 앱으로 가져오지 않습니다.',
      };
    case 'configUnreadable':
      return {
        title: '이 계정은 쿠버네티스 설정을 읽을 수 없습니다',
        body: local
          ? '파일 권한을 확인하거나 읽을 수 있는 다른 kubeconfig 경로를 입력하세요.'
          : '터미널에서 이 계정이 쓸 복사본을 만듭니다. sudo 암호는 터미널에 직접 입력하며 앱은 받거나 저장하지 않습니다. root로 접속하는 세션을 쓰는 방법도 있습니다.',
      };
    case 'authFailed':
      return {
        title: '클러스터 인증에 실패했습니다',
        body: local
          ? 'kubeconfig의 인증 정보가 만료됐을 수 있습니다. 터미널에서 다시 로그인한 뒤 다시 확인하세요.'
          : '설정 복사본이 낡았을 수 있습니다. 인증서를 갱신했거나 클러스터를 다시 설치했다면 복사본을 다시 만드세요.',
      };
    case 'authPluginFailed':
      return {
        title: '인증 플러그인을 실행하지 못했습니다',
        body: `kubeconfig가 부르는 인증 프로그램이 설치되어 있고 터미널의 PATH에 있는지 확인하세요. kubectl 메시지: ${state.message}`,
      };
    case 'forbidden':
      return {
        title: '이 계정은 일부 항목을 볼 권한이 없습니다',
        body: '권한이 있는 항목만 표시합니다.',
      };
    case 'contextMissing':
      return {
        title: '저장된 context를 찾을 수 없습니다',
        body: 'kubeconfig가 바뀌었을 수 있습니다. context를 다시 선택하세요.',
      };
    case 'unreachable':
      return {
        title: '클러스터에 연결할 수 없습니다',
        body: `${local ? '이 컴퓨터' : '이 서버'}에서 API 서버에 연결하지 못했습니다. 클러스터가 켜져 있는지 확인하세요.`,
      };
    case 'channelLimit':
      return {
        title: '서버의 동시 세션 한도에 걸렸습니다',
        body: '이 연결에서 이미 많은 작업이 실행 중입니다. 파일 전송이나 다른 탭을 줄이고 다시 확인하세요.',
      };
    // Only polling and the pod views report these; setup checks read too little to reach them.
    case 'notFound':
    case 'metricsMissing':
    case 'timedOut':
    case 'tooLarge':
      return { title: '쿠버네티스 조회가 끝나지 않았습니다', body: stateNote(state) };
    case 'unknown':
      return { title: '쿠버네티스 확인에 실패했습니다', body: state.message };
  }
}

/** `kubeconfig` is empty for commands such as `microk8s kubectl` that know their own. */
export const settingsFrom = (
  detection: Detection,
  context: string,
  namespace: string,
): KubeSettings => ({
  context,
  namespace,
  kubectl: detection.kubectl,
  kubeconfig: detection.kubeconfig,
  operate: false,
});

export type KubeDisplay = 'off' | 'workspace' | 'terminal';

/** Nothing takes over the tab until the connection is up: host keys and logins are in the terminal. */
export function kubeDisplay(facts: {
  workspace: 'terminal' | 'kubernetes' | undefined;
  opened: boolean;
  onTerminal: boolean;
  connected: boolean;
}): KubeDisplay {
  if (!facts.connected || !(facts.workspace === 'kubernetes' || facts.opened)) return 'off';
  return facts.onTerminal ? 'terminal' : 'workspace';
}

/** `fixed` is a session that always shows the workspace, so the menu has nothing to switch. */
export type KubeMenu = 'open' | 'close' | 'fixed';

export const kubeMenu = (workspace: 'terminal' | 'kubernetes' | undefined, opened: boolean) =>
  workspace === 'kubernetes' ? 'fixed' : opened ? 'close' : 'open';

export type KubeCopyResult = { blocked: string } | { typed: 'run' | 'wait' };

export function copyResultNote(result: KubeCopyResult) {
  if ('blocked' in result) return result.blocked;
  return result.typed === 'run'
    ? '터미널에 sudo 암호를 입력한 뒤 다시 확인을 누르세요.'
    : '터미널에 명령을 넣었습니다. Enter를 누르고 sudo 암호를 입력한 뒤 다시 확인을 누르세요.';
}

/** Fixed screens of the workspace, the first screen first. KV.3 and later fill the others. */
export const kubeScreens = [
  { id: 'tree', label: '트리' },
  { id: 'dashboard', label: '대시보드' },
  { id: 'problems', label: '문제 목록' },
  { id: 'changes', label: '변화 기록' },
  { id: 'ingress', label: '인그레스' },
  { id: 'ai', label: 'vLLM·GPU' },
  { id: 'board', label: '실시간 로그' },
  { id: 'logs', label: '로그 검색' },
] as const;
export type KubeScreen = (typeof kubeScreens)[number]['id'];
