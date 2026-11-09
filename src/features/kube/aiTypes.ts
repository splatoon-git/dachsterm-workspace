import type { KubeState } from './kubeModel';

/** Mirrors `kube/ai_parse.rs` and `kube/ai_collect.rs`. */
export type VllmMetric =
  | 'run'
  | 'wait'
  | 'kv'
  | 'done'
  | 'input'
  | 'output'
  | 'ttftSum'
  | 'ttftCount'
  | 'e2eSum'
  | 'e2eCount'
  | 'queueSum'
  | 'queueCount';

export type VllmSeries = { metric: VllmMetric; model: string; labels: string; value: number };

export type VllmSample = { atMs: number; processStart: number | null; series: VllmSeries[] };

export type ScrapeStatus = 'ok' | 'forbidden' | 'unreachable' | 'noSupported' | 'invalidTarget';

export type VllmPod = {
  namespace: string;
  pod: string;
  node: string;
  identity: string;
  status: ScrapeStatus;
  endpoint: string;
  sample: VllmSample | null;
};

export type GpuExporter = {
  namespace: string;
  pod: string;
  node: string;
  status: ScrapeStatus;
  endpoint: string;
};

export type GpuDevice = {
  node: string;
  id: string;
  gpu: string;
  model: string;
  util: number | null;
  used: number | null;
  total: number | null;
  temp: number | null;
  power: number | null;
  pods: string[];
};

export type AiRead = {
  state: KubeState;
  pods: VllmPod[];
  exporters: GpuExporter[];
  gpus: GpuDevice[];
  capped: number;
  gpuRestricted: boolean;
  elapsedMs: number;
};
