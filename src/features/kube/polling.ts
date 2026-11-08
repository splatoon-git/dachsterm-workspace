import type { KubeState } from './kubeModel';
import type { Snapshot, SnapshotItems, SnapshotKind } from './snapshotTypes';

/** Design KV.2. The periods are the shortest wait; a slow cluster stretches them. */
export const pollPeriods: Record<SnapshotKind, number> = {
  pods: 5_000,
  workloads: 15_000,
  services: 30_000,
  nodes: 15_000,
  podUsage: 15_000,
  nodeUsage: 15_000,
  events: 15_000,
};
export const snapshotKinds = Object.keys(pollPeriods) as SnapshotKind[];

const SLOW_FACTOR = 3;
const LIMIT_FACTOR = 4;
const MAX_BACKOFF = 120_000;

type KindSchedule = { inFlight: boolean; nextAt: number };
export type Schedule = Record<SnapshotKind, KindSchedule>;

const eachKind = (make: (kind: SnapshotKind) => KindSchedule) =>
  Object.fromEntries(snapshotKinds.map((kind) => [kind, make(kind)])) as Schedule;

export const newSchedule = (now: number): Schedule =>
  eachKind(() => ({ inFlight: false, nextAt: now }));

/** A tab shown again refreshes at once, except what is still running: one request per kind. */
export const resumed = (schedule: Schedule, now: number): Schedule =>
  eachKind((kind) => (schedule[kind].inFlight ? schedule[kind] : { inFlight: false, nextAt: now }));

export const dueKinds = (schedule: Schedule, now: number) =>
  snapshotKinds.filter((kind) => !schedule[kind].inFlight && schedule[kind].nextAt <= now);

export const started = (schedule: Schedule, kind: SnapshotKind): Schedule => ({
  ...schedule,
  [kind]: { ...schedule[kind], inFlight: true },
});

/**
 * The wait starts after the previous run ended. A refused channel is only a busy connection, so it
 * tries again on the normal period. A limit means this scope is too big to poll at this rate.
 */
export function delayAfter(kind: SnapshotKind, elapsedMs: number, state: KubeState) {
  const period = Math.max(pollPeriods[kind], elapsedMs * SLOW_FACTOR);
  if (state.kind === 'timedOut' || state.kind === 'tooLarge')
    return Math.min(MAX_BACKOFF, Math.max(period, pollPeriods[kind] * LIMIT_FACTOR));
  return period;
}

export const finished = (
  schedule: Schedule,
  kind: SnapshotKind,
  now: number,
  snapshot: Pick<Snapshot, 'elapsedMs' | 'state'>,
): Schedule => ({
  ...schedule,
  [kind]: { inFlight: false, nextAt: now + delayAfter(kind, snapshot.elapsedMs, snapshot.state) },
});

/** Milliseconds until the next kind is due; `null` while every kind is running. */
export function nextWakeIn(schedule: Schedule, now: number) {
  const waiting = snapshotKinds.filter((kind) => !schedule[kind].inFlight);
  if (!waiting.length) return null;
  return Math.max(0, Math.min(...waiting.map((kind) => schedule[kind].nextAt)) - now);
}

type Entry<K extends SnapshotKind> = {
  data: SnapshotItems[K] | null;
  /** When `data` was collected. It does not move when a later poll fails. */
  collectedAt: number | null;
  state: KubeState | null;
};
export type SnapshotStore = { [K in SnapshotKind]: Entry<K> };

export const emptySnapshots = () =>
  Object.fromEntries(
    snapshotKinds.map((kind) => [kind, { data: null, collectedAt: null, state: null }]),
  ) as SnapshotStore;

/** What a poll that failed in the app, not in kubectl, looks like to the rest of the code. */
export const failedSnapshot = (message: string): Snapshot => ({
  state: { kind: 'unknown', message },
  data: null,
  collectedAt: Date.now(),
  elapsedMs: 0,
});

/**
 * A failed poll keeps the last data, so a brief outage does not blank the screen. Two states mean
 * the data will not come at all, and only that kind is emptied: no permission, no metrics-server.
 */
export function applySnapshot(
  store: SnapshotStore,
  kind: SnapshotKind,
  snapshot: Snapshot,
): SnapshotStore {
  const { state, data, collectedAt } = snapshot;
  const entry =
    state.kind === 'ready' && data
      ? { data: data.items, collectedAt, state }
      : state.kind === 'forbidden' || state.kind === 'metricsMissing'
        ? { data: null, collectedAt: null, state }
        : { ...store[kind], state };
  return { ...store, [kind]: entry } as SnapshotStore;
}

export function stateNote(state: KubeState): string {
  switch (state.kind) {
    case 'ready':
      return '';
    case 'unreachable':
      return '클러스터 연결 불가';
    case 'authFailed':
      return '클러스터 인증 실패';
    case 'forbidden':
      return '권한 없음';
    case 'contextMissing':
      return 'context를 찾을 수 없음';
    case 'kubectlMissing':
      return 'kubectl을 찾을 수 없음';
    case 'configMissing':
      return '쿠버네티스 설정 파일 없음';
    case 'configUnreadable':
      return '쿠버네티스 설정을 읽을 수 없음';
    case 'channelLimit':
      return '서버의 동시 세션 한도에 걸림';
    case 'notFound':
      return '파드를 찾을 수 없음';
    case 'metricsMissing':
      return 'metrics-server 없음';
    case 'timedOut':
      return '조회 시간 초과, namespace를 좁히세요';
    case 'tooLarge':
      return '조회 결과가 너무 큼, namespace를 좁히세요';
    case 'unknown':
      return state.message;
  }
}

const ageAgo = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  return `${Math.floor(seconds / 3600)}시간 전`;
};

/** The header's reading of the pod list, which is what the tree shows and refreshes fastest. */
export function freshness(store: SnapshotStore, now: number) {
  const { collectedAt, state } = store.pods;
  return {
    age: collectedAt === null ? null : ageAgo(now - collectedAt),
    warning: state && state.kind !== 'ready' ? stateNote(state) : null,
  };
}

const kindNames: Record<SnapshotKind, string> = {
  pods: '파드',
  workloads: '워크로드',
  services: '서비스',
  nodes: '노드',
  podUsage: '파드 사용량',
  nodeUsage: '노드 사용량',
  events: '경고 이벤트',
};

/** One line for each kind that did not arrive, so an empty column has a reason next to it. */
export function kindNotes(store: SnapshotStore) {
  return snapshotKinds.flatMap((kind) => {
    const state = store[kind].state;
    return kind !== 'pods' && state && state.kind !== 'ready'
      ? [`${kindNames[kind]}: ${stateNote(state)}`]
      : [];
  });
}
