import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { KubeSettings } from '../../lib/ipc';
import {
  EventsView,
  OverviewView,
  RelationsView,
  YamlView,
  type UsageSample,
} from './PodInfoViews';
import { PodCauseView } from './PodCauseView';
import { PodLogsView } from './PodLogsView';
import { panelTabs, type PodPanelTab, type PodPanelTarget } from './podPanel';
import type { PodTerminalRequest } from './podShell';
import type { SnapshotStore } from './polling';
import { detailNote, readDetail, useKubeRead } from './useKubeRead';
import './kubePanel.css';

const MAX_SAMPLES = 120;

/** The panel beside the tree. `Esc` closes it from here or from the tree; the cursor stays. */
export function KubePodPanel({
  connectionId,
  kube,
  session,
  target,
  store,
  setTab,
  close,
  openTerminal,
  style,
}: {
  connectionId: string;
  kube: KubeSettings;
  session: string;
  target: PodPanelTarget & { problem: boolean };
  store: SnapshotStore;
  setTab: (tab: PodPanelTab) => void;
  close: () => void;
  openTerminal: (request: PodTerminalRequest) => void;
  style?: CSSProperties;
}) {
  const [tick, setTick] = useState(0);
  const pod = { namespace: target.namespace, name: target.name };
  const read = useKubeRead(
    () => readDetail(connectionId, kube, pod, 'overview'),
    `${target.namespace}/${target.name}/${tick}`,
  );
  const overview = read.data?.data?.kind === 'overview' ? read.data.data : null;
  const overviewNote = detailNote(read.data, read.error);

  // Only the samples taken while this panel is open: nothing is kept after it closes.
  const [trend, setTrend] = useState<{ at: number | null; samples: UsageSample[] }>({
    at: null,
    samples: [],
  });
  const usage =
    store.podUsage.data?.find(
      (item) => item.namespace === target.namespace && item.name === target.name,
    ) ?? null;
  if (usage && store.podUsage.collectedAt !== trend.at)
    setTrend({
      at: store.podUsage.collectedAt,
      samples: [
        ...trend.samples.slice(-(MAX_SAMPLES - 1)),
        { cpu: usage.cpu, memory: usage.memory },
      ],
    });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== 'Escape') return;
    event.preventDefault();
    close();
  };
  const reads = { connectionId, kube, target: pod, tick };
  return (
    <section
      className="kube-panel"
      style={style}
      aria-label={`${target.name} 상세`}
      onKeyDown={onKeyDown}
    >
      <div className="kube-panel-head">
        <strong title={target.name}>{target.name}</strong>
        <span className="kube-panel-namespace">{target.namespace}</span>
        <button aria-label="새로고침" title="새로고침" onClick={() => setTick((n) => n + 1)}>
          ⟳
        </button>
        <button aria-label="패널 닫기" title="닫기 (Esc)" onClick={close}>
          ×
        </button>
      </div>
      <div className="kube-panel-tabs" role="tablist" aria-label="파드 상세">
        {panelTabs(target.problem).map(({ id, label }) => (
          <button key={id} role="tab" aria-selected={target.tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="kube-panel-body" role="tabpanel">
        {overviewNote && target.tab !== 'yaml' && target.tab !== 'events' && (
          <p className="kube-panel-note">{overviewNote}</p>
        )}
        {target.tab === 'logs' && (
          <PodLogsView
            key={`${target.namespace}/${target.name}`}
            connectionId={connectionId}
            kube={kube}
            target={pod}
            overview={overview}
            session={session}
            tick={tick}
            openTerminal={openTerminal}
          />
        )}
        {target.tab === 'cause' && overview && (
          <PodCauseView
            key={`${target.namespace}/${target.name}`}
            connectionId={connectionId}
            kube={kube}
            target={pod}
            overview={overview}
            tick={tick}
          />
        )}
        {target.tab === 'overview' && overview && (
          <OverviewView overview={overview} usage={usage} trend={trend.samples} />
        )}
        {target.tab === 'events' && <EventsView {...reads} />}
        {target.tab === 'yaml' && <YamlView {...reads} />}
        {target.tab === 'relations' && <RelationsView {...reads} />}
      </div>
    </section>
  );
}
