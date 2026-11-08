import type { KubeState } from './kubeModel';

/** Mirrors `kube/snapshot.rs`. CPU is in millicores and memory in bytes. */
export type ContainerState = {
  name: string;
  ready: boolean;
  restarts: number;
  waiting: string;
  terminated: string;
  lastReason: string;
  lastFinished: string;
  /** Why the previous run ended; `null` when it has not ended yet or the cluster did not say. */
  lastExitCode: number | null;
};

export type KubePod = {
  namespace: string;
  name: string;
  node: string;
  phase: string;
  reason: string;
  created: string;
  deleting: boolean;
  ownerKind: string;
  ownerName: string;
  labels: Record<string, string>;
  /** What a plain `kubectl logs` reads: the annotation, then the first in the spec. */
  defaultContainer: string;
  containerCount: number;
  cpuRequest: number | null;
  memoryRequest: number | null;
  cpuLimit: number | null;
  memoryLimit: number | null;
  initContainers: ContainerState[];
  containers: ContainerState[];
};

export type KubeWorkload = {
  kind: string;
  namespace: string;
  name: string;
  desired: number;
  ready: number;
};

export type KubeService = {
  namespace: string;
  name: string;
  serviceType: string;
  selector: Record<string, string>;
  readyEndpoints: number;
  notReadyEndpoints: number;
};

export type KubeNode = {
  name: string;
  ready: boolean;
  unschedulable: boolean;
  cpuAllocatable: number | null;
  memoryAllocatable: number | null;
};

export type KubePodUsage = { namespace: string; name: string; cpu: number; memory: number };
export type KubeNodeUsage = { name: string; cpu: number; memory: number };

export type KubeEvent = {
  namespace: string;
  objectKind: string;
  objectName: string;
  reason: string;
  time: string;
  message: string;
};

export type SnapshotItems = {
  pods: KubePod[];
  workloads: KubeWorkload[];
  services: KubeService[];
  nodes: KubeNode[];
  podUsage: KubePodUsage[];
  nodeUsage: KubeNodeUsage[];
  events: KubeEvent[];
};
export type SnapshotKind = keyof SnapshotItems;

export type SnapshotData = {
  [K in SnapshotKind]: { kind: K; items: SnapshotItems[K] };
}[SnapshotKind];

export type Snapshot = {
  state: KubeState;
  data: SnapshotData | null;
  collectedAt: number;
  elapsedMs: number;
};
