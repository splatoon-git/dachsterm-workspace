import type { KubeState } from './kubeModel';

/** Mirrors `kube/ingress.rs` and `kube/ingress_metrics.rs`. */
export type BackendHealth = 'ok' | 'noService' | 'noReady' | 'external' | 'unchecked';

export type IngressRule = {
  host: string;
  path: string;
  pathType: string;
  service: string;
  port: string;
  isDefault: boolean;
  backend: BackendHealth;
  readyEndpoints: number;
  notReadyEndpoints: number;
};

export type IngressTls = { secret: string; hosts: string[]; missing: boolean };

export type KubeIngress = {
  namespace: string;
  name: string;
  className: string;
  addresses: string[];
  tls: IngressTls[];
  rules: IngressRule[];
};

export type IngressController = { namespace: string; name: string; container: string };

/** Cumulative since each controller started, summed across controllers. */
export type HostTraffic = {
  host: string;
  ok: number;
  redirect: number;
  clientError: number;
  serverError: number;
  other: number;
  durationSum: number;
  durationCount: number;
};

export type Traffic =
  | { kind: 'notRead' }
  | { kind: 'noController' }
  | { kind: 'controllersUnknown'; state: KubeState }
  | { kind: 'off' }
  | { kind: 'proxyForbidden' }
  | { kind: 'failed'; state: KubeState }
  | {
      kind: 'ready';
      controllers: number;
      read: number;
      hosts: HostTraffic[];
      connections: number;
    };

export type IngressReport = {
  state: KubeState;
  ingresses: KubeIngress[] | null;
  servicesState: KubeState;
  secretsState: KubeState;
  controllers: IngressController[];
  traffic: Traffic;
  collectedAt: number;
  elapsedMs: number;
};
