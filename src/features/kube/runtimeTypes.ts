import type { KubeState } from './kubeModel';

/** Mirrors `kube/metrics.rs` and `kube/probe.rs`. */
export type MetricSeries = { name: string; labels: string; value: number };
export type MetricCandidate = { port: number; path: string; https: boolean; annotated: boolean };
export type ContainerThreads = { container: string; threads: number };
export type NoMetricsReason = 'notFound' | 'refused' | 'notPrometheus';

export type MetricsData =
  | { kind: 'candidates'; items: MetricCandidate[] }
  | { kind: 'series'; items: MetricSeries[]; total: number }
  | { kind: 'absent'; reason: NoMetricsReason }
  | { kind: 'threads'; containers: ContainerThreads[] };

export type MetricsRead = { state: KubeState; data: MetricsData | null; elapsedMs: number };

export type MetricSource = { port: number; path: string; https: boolean };

export type MetricsTarget =
  | { kind: 'candidates'; namespace: string; pod: string }
  | ({ kind: 'pod'; namespace: string; pod: string; only: string[] | null } & MetricSource)
  | { kind: 'threads'; namespace: string; pod: string; node: string };

export type ProbeProcess = {
  pid: number;
  name: string;
  state: string;
  threads: number;
  fds: number | null;
  fdLimit: number | null;
  ageSeconds: number | null;
};

export type TcpStates = {
  established: number;
  synSent: number;
  synRecv: number;
  finWait1: number;
  finWait2: number;
  timeWait: number;
  close: number;
  closeWait: number;
  lastAck: number;
  listen: number;
  closing: number;
};

export type ListenPort = { port: number; backlog: number; queued: number };

export type Runtime = {
  processes: ProbeProcess[];
  truncated: boolean;
  tcp: TcpStates;
  listen: ListenPort[];
  counters: {
    listenOverflows: number | null;
    listenDrops: number | null;
    retransmitted: number | null;
  };
};

export type ProbeRead =
  | { kind: 'ready'; runtime: Runtime; elapsedMs: number }
  | { kind: 'noShell' }
  | { kind: 'notRunning' }
  | { kind: 'blocked'; state: KubeState };
