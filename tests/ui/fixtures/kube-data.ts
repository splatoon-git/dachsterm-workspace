import type { Detection, KubeState } from '../../../src/features/kube/kubeModel';
import type { KubePod, Snapshot, SnapshotData } from '../../../src/features/kube/snapshotTypes';

export const NOW = Date.parse('2026-11-08T12:00:00Z');
export const saved = {
  context: 'prod',
  namespace: '',
  kubectl: '/k',
  kubeconfig: '/c',
  operate: false,
};
export const detection: Detection = {
  state: { kind: 'ready' },
  kubectl: '/k',
  kubeconfig: '/c',
  context: 'prod',
  contexts: ['prod'],
  namespaces: ['web'],
  namespacesForbidden: false,
  saved,
};

export const pod = (name: string, patch: Partial<KubePod> = {}): KubePod => ({
  namespace: 'web',
  name,
  node: 'n1',
  phase: 'Running',
  reason: '',
  created: '2026-11-08T11:00:00Z',
  deleting: false,
  ownerKind: 'ReplicaSet',
  ownerName: 'api-7f9c',
  labels: { app: 'api', 'pod-template-hash': '7f9c' },
  defaultContainer: 'app',
  containerCount: 1,
  cpuRequest: 100,
  memoryRequest: 2 ** 20,
  cpuLimit: 200,
  memoryLimit: 2 ** 21,
  initContainers: [],
  containers: [
    {
      name: 'app',
      ready: true,
      restarts: 0,
      waiting: '',
      terminated: '',
      lastReason: '',
      lastFinished: '',
      lastExitCode: null,
    },
  ],
  ...patch,
});

export const ok = (data: SnapshotData, collectedAt = NOW): Snapshot => ({
  state: { kind: 'ready' },
  data,
  collectedAt,
  elapsedMs: 5,
});
export const failed = (state: KubeState): Snapshot => ({
  state,
  data: null,
  collectedAt: NOW,
  elapsedMs: 5,
});
