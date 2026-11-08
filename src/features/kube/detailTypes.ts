import type { KubeState } from './kubeModel';

/** Mirrors `kube/detail.rs`, `kube/logs.rs` and `ShellCheck` in `kube/state.rs`. */
export type Termination = {
  reason: string;
  message: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
};

export type ContainerDetail = {
  name: string;
  image: string;
  ready: boolean;
  restarts: number;
  state: '' | 'running' | 'waiting' | 'terminated';
  reason: string;
  message: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  containerId: string;
  last: Termination | null;
  cpuRequest: number | null;
  memoryRequest: number | null;
  cpuLimit: number | null;
  memoryLimit: number | null;
};

export type PodOverview = {
  namespace: string;
  name: string;
  uid: string;
  phase: string;
  reason: string;
  message: string;
  node: string;
  podIp: string;
  hostIp: string;
  qosClass: string;
  created: string;
  deleting: boolean;
  ownerKind: string;
  ownerName: string;
  defaultContainer: string;
  labels: Record<string, string>;
  initContainers: ContainerDetail[];
  containers: ContainerDetail[];
};

export type PodEvent = {
  eventType: string;
  reason: string;
  count: number;
  time: string;
  message: string;
};

export type ServiceLink = { name: string; inRotation: boolean | null };
export type IngressLink = { name: string; hosts: string[]; services: string[] };
export type Section<T> = { state: KubeState; items: T[] };

export type PodRelations = {
  services: Section<ServiceLink>;
  ingresses: Section<IngressLink>;
  networkPolicies: Section<string>;
  pvcs: string[];
  configMaps: string[];
};

export type DetailKind = 'overview' | 'events' | 'yaml' | 'relations';

export type DetailData =
  | ({ kind: 'overview' } & PodOverview)
  | { kind: 'events'; items: PodEvent[] }
  | { kind: 'yaml'; text: string }
  | ({ kind: 'relations' } & PodRelations);

export type Detail = { state: KubeState; data: DetailData | null };

export type PodLogs = {
  state: KubeState;
  text: string;
  previous: boolean;
  previousMissing: boolean;
  truncated: boolean;
};

export type ShellCheck =
  | { kind: 'ready' }
  | { kind: 'noShell' }
  | { kind: 'notRunning' }
  | { kind: 'blocked'; state: KubeState };

export type PodRef = { namespace: string; name: string };
