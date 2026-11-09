import { useEffect, useRef, useState } from 'react';
import { Dialog, defaultChoice } from '../../components/Dialog';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import type { PodOverview, PodRef } from './detailTypes';
import { PodMetricsView } from './PodMetricsView';
import { chooseContainer, workloadKey } from './podPanel';
import {
  ConnectionsSection,
  ProcessesSection,
  RuntimePanel,
  ThreadsSection,
} from './RuntimeSections';
import type { MetricsRead, ProbeRead, Runtime } from './runtimeTypes';
import { useKubeRead } from './useKubeRead';
import { useWorkers } from './workerContext';
import { probeReadNote } from './workers';
import './kubeRuntime.css';

type Collected = { current: Runtime; previous: Runtime | null; at: number };

const clockTime = (at: number) => new Date(at).toTimeString().slice(0, 8);

/** The runtime tab: threads from the node, processes and connections from a probe, then metrics. */
export function PodRuntimeView({
  connectionId,
  kube,
  target,
  overview,
  session,
  tick,
}: {
  connectionId: string;
  kube: KubeSettings;
  target: PodRef;
  overview: PodOverview;
  session: string;
  tick: number;
}) {
  const workers = useWorkers();
  const key = workloadKey(overview);
  const containers = overview.containers.map((item) => item.name);
  const [container, setContainer] = useState(
    () => chooseContainer(overview, session) ?? containers[0] ?? '',
  );
  const [collected, setCollected] = useState<Collected | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingConsent, setPendingConsent] = useState<(() => void) | null>(null);

  const threads = useKubeRead<MetricsRead>(
    () =>
      overview.node
        ? call<MetricsRead>('kube_metrics', {
            id: connectionId,
            kube,
            target: {
              kind: 'threads',
              namespace: target.namespace,
              pod: target.name,
              node: overview.node,
            },
          })
        : Promise.resolve(null),
    `${target.namespace}/${target.name}/${overview.node}/${tick}`,
  );

  const collect = async () => {
    setBusy(true);
    setNote('');
    try {
      const read = await call<ProbeRead>('kube_probe', {
        id: connectionId,
        kube,
        target: { namespace: target.namespace, pod: target.name },
        container,
      });
      if (read.kind === 'ready') {
        const runtime = read.runtime;
        const at = Date.now();
        setCollected((now) => ({ current: runtime, previous: now?.current ?? null, at }));
      } else {
        setCollected(null);
        setNote(probeReadNote(read));
      }
    } catch (error) {
      setNote(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  /** The first run for a workload asks once; later runs just go. */
  const withConsent = (then: () => void) => {
    if (workers.hasConsent(key)) then();
    else setPendingConsent(() => then);
  };

  // No permission for the node's metrics means the probe is the only source of thread counts. It
  // runs by itself only where the user has already allowed it for this workload.
  const fellBack = useRef(false);
  const forbidden = threads.data?.state.kind === 'forbidden';
  useEffect(() => {
    if (!forbidden || fellBack.current || !workers.hasConsent(key) || !container) return;
    fellBack.current = true;
    void collect();
    // Only the arrival of the refusal starts this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forbidden]);

  return (
    <div className="kube-rt">
      <ThreadsSection read={threads.data} loading={threads.loading} />
      <RuntimePanel
        label="파드 안에서 읽기"
        tools={
          <>
            {collected && <span className="kube-rt-at">{clockTime(collected.at)} 기준</span>}
            {containers.length > 1 && (
              <select
                aria-label="런타임 컨테이너"
                value={container}
                onChange={(event) => setContainer(event.target.value)}
              >
                {containers.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            )}
            <button disabled={busy || !container} onClick={() => withConsent(() => void collect())}>
              {busy ? '읽는 중…' : '수집'}
            </button>
          </>
        }
      >
        {note && (
          <p className="kube-rt-note warn" role="status">
            {note}
          </p>
        )}
        {!collected && !note && (
          <p className="kube-rt-note">
            수집을 누르면 프로세스, 열린 파일 수, TCP 연결 상태를 파드 안에서 읽습니다.
          </p>
        )}
        {collected && (
          <div className="kube-rt-columns">
            <ProcessesSection runtime={collected.current} />
            <ConnectionsSection current={collected.current} previous={collected.previous} />
          </div>
        )}
      </RuntimePanel>
      <div className="kube-rt-columns panels">
        <PodMetricsView
          connectionId={connectionId}
          kube={kube}
          target={target}
          overview={overview}
          workloadKey={key}
          container={container}
          tick={tick}
          requestConsent={withConsent}
        />
      </div>
      {pendingConsent && (
        <Dialog title="런타임 읽기" size="small" close={() => setPendingConsent(null)}>
          <p>
            파드 안에서 읽기 명령을 실행합니다. 앱에 고정된 스크립트가 <code>/proc</code>을 읽기만
            하며 다른 명령은 실행하지 않습니다.
          </p>
          <div className="form-actions">
            <button type="button" onClick={() => setPendingConsent(null)}>
              취소
            </button>
            <button
              type="button"
              className="primary"
              ref={defaultChoice}
              onClick={() => {
                workers.grantConsent(key);
                pendingConsent();
                setPendingConsent(null);
              }}
            >
              실행
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
