import { capped, part, troubles, underReady, type Capped, type Part } from './dashboard';
import type { SnapshotStore } from './polling';
import type { KubeHpa, KubeJob, KubeNode, KubePod, KubePvc, KubeWorkload } from './snapshotTypes';
import { podViews, type Health } from './treePods';
import type { TreeTarget } from './treeReveal';

export type ProblemKind = 'node' | 'workload' | 'pvc' | 'job' | 'hpa' | 'pod' | 'restart';

export type Problem = {
  /** `kind:object`, the identity a problem keeps across snapshots. */
  key: string;
  kind: ProblemKind;
  health: Exclude<Health, 'ok'>;
  object: string;
  detail: string;
  target: TreeTarget | null;
};

/** The problems in one snapshot kind, and every object it listed, problem or not. */
export type Reading = { problems: Problem[]; objects: ReadonlySet<string> };

export const problemSources = ['nodes', 'workloads', 'pvcs', 'jobs', 'hpas', 'pods'] as const;
export type ProblemSource = (typeof problemSources)[number];

const sourceOfKind: Record<ProblemKind, ProblemSource> = {
  node: 'nodes',
  workload: 'workloads',
  pvc: 'pvcs',
  job: 'jobs',
  hpa: 'hpas',
  pod: 'pods',
  restart: 'pods',
};
export const sourceOf = (problem: Problem) => sourceOfKind[problem.kind];
export const objectOf = (problem: Problem) => problem.key.slice(problem.kind.length + 1);

/** A long list stops here and says how many are left. */
export const PROBLEM_LIMIT = 200;
const FAILED_JOB_WINDOW = 86_400_000;

const namespaced = (item: { namespace: string; name: string }) => `${item.namespace}/${item.name}`;

function readNodes(nodes: KubeNode[]): Reading {
  return {
    problems: nodes
      .filter((node) => !node.ready)
      .map((node) => ({
        key: `node:${node.name}`,
        kind: 'node',
        health: 'error',
        object: node.name,
        detail: 'NotReady',
        target: { type: 'node', name: node.name },
      })),
    objects: new Set(nodes.map((node) => node.name)),
  };
}

const workloadId = (w: KubeWorkload) => `${w.kind}/${w.namespace}/${w.name}`;

function readWorkloads(workloads: KubeWorkload[]): Reading {
  return {
    problems: underReady(workloads).map((row) => ({
      key: `workload:${row.key}`,
      kind: 'workload',
      health: row.ready === 0 ? 'error' : 'warn',
      object: `${row.kind}/${row.namespace}/${row.name}`,
      detail: `준비 ${row.ready}/${row.desired}`,
      target: row.target,
    })),
    objects: new Set(workloads.map(workloadId)),
  };
}

/** `Lost` will not recover by itself. `Pending` may only be waiting for its first pod. */
function readPvcs(pvcs: KubePvc[]): Reading {
  return {
    problems: pvcs
      .filter((pvc) => pvc.phase !== 'Bound')
      .map((pvc) => ({
        key: `pvc:${namespaced(pvc)}`,
        kind: 'pvc',
        health: pvc.phase === 'Lost' ? 'error' : 'warn',
        object: namespaced(pvc),
        detail: pvc.phase || 'Pending',
        target: { type: 'namespace', namespace: pvc.namespace },
      })),
    objects: new Set(pvcs.map(namespaced)),
  };
}

/** RFC 3339 in UTC, so the text sorts as the time does. */
function newestRuns(jobs: KubeJob[]) {
  const newest = new Map<string, KubeJob>();
  for (const job of jobs) {
    if (job.ownerKind !== 'CronJob') continue;
    const owner = `${job.namespace}/${job.ownerName}`;
    const known = newest.get(owner);
    if (!known || job.created >= known.created) newest.set(owner, job);
  }
  return new Set(newest.values());
}

/**
 * A later success clears a CronJob's old failure, so only its newest run counts. A Job on its own
 * has no later run, and stops being news after a day.
 */
function readJobs(jobs: KubeJob[], now: number): Reading {
  const newest = newestRuns(jobs);
  const counts = (job: KubeJob) =>
    job.ownerKind === 'CronJob'
      ? newest.has(job)
      : !(now - Date.parse(job.failedAt) > FAILED_JOB_WINDOW);
  return {
    problems: jobs
      .filter((job) => job.failed && counts(job))
      .map((job) => ({
        key: `job:${namespaced(job)}`,
        kind: 'job',
        health: 'error',
        object: namespaced(job),
        detail: [job.reason || '실패', job.ownerKind === 'CronJob' && `CronJob ${job.ownerName}`]
          .filter(Boolean)
          .join(' · '),
        target: { type: 'workload', kind: 'Job', namespace: job.namespace, name: job.name },
      })),
    objects: new Set(jobs.map(namespaced)),
  };
}

function hpaTarget(hpa: KubeHpa): TreeTarget {
  return hpa.targetKind === 'Deployment' || hpa.targetKind === 'StatefulSet'
    ? { type: 'workload', kind: hpa.targetKind, namespace: hpa.namespace, name: hpa.targetName }
    : { type: 'namespace', namespace: hpa.namespace };
}

function readHpas(hpas: KubeHpa[]): Reading {
  return {
    problems: hpas
      .filter((hpa) => hpa.max > 0 && hpa.current >= hpa.max)
      .map((hpa) => ({
        key: `hpa:${namespaced(hpa)}`,
        kind: 'hpa',
        health: 'warn',
        object: namespaced(hpa),
        detail: `최대치 ${hpa.current}/${hpa.max}`,
        target: hpaTarget(hpa),
      })),
    objects: new Set(hpas.map(namespaced)),
  };
}

/** The same pods as the tree's "problems only", split into broken now and restarted lately. */
function readPods(pods: KubePod[], now: number): Reading {
  const views = podViews(pods, [], [], now);
  const healthOf = new Map(views.map((view) => [view.key, view.health]));
  return {
    problems: troubles(views, new Map()).map((row) => {
      const kind = healthOf.get(row.key) === 'ok' ? 'restart' : 'pod';
      return {
        key: `${kind}:${row.key}`,
        kind,
        health: row.health === 'error' ? 'error' : 'warn',
        object: row.key,
        detail: row.detail,
        target: row.target,
      };
    }),
    objects: new Set(pods.map(namespaced)),
  };
}

/** `null` until this kind has data. */
export function readProblems(source: ProblemSource, store: SnapshotStore): Reading | null {
  const at = store[source].collectedAt ?? 0;
  switch (source) {
    case 'nodes':
      return store.nodes.data && readNodes(store.nodes.data);
    case 'workloads':
      return store.workloads.data && readWorkloads(store.workloads.data);
    case 'pvcs':
      return store.pvcs.data && readPvcs(store.pvcs.data);
    case 'jobs':
      return store.jobs.data && readJobs(store.jobs.data, at);
    case 'hpas':
      return store.hpas.data && readHpas(store.hpas.data);
    case 'pods':
      return store.pods.data && readPods(store.pods.data, at);
  }
}

export type ProblemSection = {
  kind: ProblemKind;
  title: string;
  /** Not `ready` means this kind is unknown. It must never read as "no problems". */
  part: Part<Capped<Problem>>;
};

const sectionTitles: [ProblemKind, string][] = [
  ['node', 'NotReady 노드'],
  ['workload', '미달 워크로드'],
  ['pvc', '대기 PVC'],
  ['job', '실패 Job'],
  ['hpa', '최대치 HPA'],
  ['pod', '문제 파드'],
  ['restart', '최근 재시작'],
];

export function problemSections(store: SnapshotStore): ProblemSection[] {
  const readings = new Map(problemSources.map((source) => [source, readProblems(source, store)]));
  return sectionTitles.map(([kind, title]) => {
    const source = sourceOfKind[kind];
    return {
      kind,
      title,
      part: part({ data: readings.get(source) ?? null, state: store[source].state }, (reading) =>
        capped(
          reading.problems.filter((problem) => problem.kind === kind),
          PROBLEM_LIMIT,
        ),
      ),
    };
  });
}

export const problemCount = (sections: ProblemSection[]) =>
  sections.reduce(
    (total, { part: section }) =>
      total + (section.state === 'ready' ? section.value.items.length + section.value.more : 0),
    0,
  );
