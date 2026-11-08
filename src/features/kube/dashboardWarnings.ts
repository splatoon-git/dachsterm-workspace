import type { KubeEvent } from './snapshotTypes';
import type { TreeTarget } from './treeReveal';

export const WARNING_WINDOW = 10 * 60_000;

export type WarningRow = {
  key: string;
  target: TreeTarget | null;
  at: number;
  reason: string;
  object: string;
  message: string;
};

function eventTarget(event: KubeEvent): TreeTarget | null {
  switch (event.objectKind) {
    case 'Pod':
      return { type: 'pod', namespace: event.namespace, name: event.objectName };
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
      return {
        type: 'workload',
        kind: event.objectKind,
        namespace: event.namespace,
        name: event.objectName,
      };
    case 'Node':
      return { type: 'node', name: event.objectName };
    default:
      return event.namespace ? { type: 'namespace', namespace: event.namespace } : null;
  }
}

export function recentWarnings(events: KubeEvent[], now: number): WarningRow[] {
  return events
    .map((event, at) => ({ event, time: Date.parse(event.time), at }))
    .filter(({ time }) => Number.isFinite(time) && now - time <= WARNING_WINDOW)
    .sort((a, b) => b.time - a.time || a.at - b.at)
    .map(({ event, time, at }) => ({
      key: `${at}/${event.namespace}/${event.objectName}/${event.reason}`,
      target: eventTarget(event),
      at: time,
      reason: event.reason,
      object: event.namespace ? `${event.namespace}/${event.objectName}` : event.objectName,
      message: event.message,
    }));
}
