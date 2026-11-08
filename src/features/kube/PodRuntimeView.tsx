import { useEffect, useRef, useState } from 'react';
import { Dialog, defaultChoice } from '../../components/Dialog';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import type { PodOverview, PodRef } from './detailTypes';
import { PodMetricsView } from './PodMetricsView';
import { chooseContainer, workloadKey } from './podPanel';
import { stateNote } from './polling';
import { formatAgeSeconds, groupProcesses, tcpRows } from './runtimeModel';
import type { MetricsRead, ProbeRead, Runtime } from './runtimeTypes';
import { useKubeRead } from './useKubeRead';
import { useWorkers } from './workerContext';
import { probeReadNote } from './workers';
import './kubeWorkers.css';

type Collected = { current: Runtime; previous: Runtime | null };

function ThreadsSection({ read, loading }: { read: MetricsRead | null; loading: boolean }) {
  const forbidden = read?.state.kind === 'forbidden';
  const containers = read?.data?.kind === 'threads' ? read.data.containers : null;
  return (
    <>
      <h3>컨테이너 스레드</h3>
      {loading && <p className="kube-panel-note">노드 메트릭을 읽는 중…</p>}
      {forbidden && (
        <p className="kube-panel-note" role="status">
          nodes/proxy 권한이 없어 노드 메트릭을 읽을 수 없습니다. 아래 수집으로 프로세스별 스레드를
          읽습니다.
        </p>
      )}
      {read && !forbidden && read.state.kind !== 'ready' && (
        <p className="kube-panel-note">{stateNote(read.state)}</p>
      )}
      {containers?.length === 0 && (
        <p className="kube-panel-note">노드 메트릭에 이 파드의 스레드 수가 없습니다.</p>
      )}
      {containers && containers.length > 0 && (
        <table className="kube-table">
          <tbody>
            {containers.map((item) => (
              <tr key={item.container}>
                <td>{item.container}</td>
                <td>{item.threads}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function ConnectionsSection({ collected }: { collected: Collected }) {
  const { current, previous } = collected;
  const growth = previous ? current.tcp.closeWait - previous.tcp.closeWait : 0;
  const { listen, counters } = current;
  const count = (value: number | null) => (value === null ? '-' : String(value));
  return (
    <>
      <h3>연결</h3>
      <div className="kube-runtime-chips">
        {tcpRows(current.tcp).map(([name, value]) => (
          <span key={name} className={name === 'CLOSE_WAIT' && growth > 0 ? 'rising' : undefined}>
            {name} {value}
            {name === 'CLOSE_WAIT' && growth > 0 && ` (+${growth})`}
          </span>
        ))}
      </div>
      <dl className="kube-facts">
        <dt>LISTEN 포트</dt>
        <dd>
          {listen.length
            ? listen.map((p) => `${p.port} (대기 ${p.queued}/${p.backlog})`).join(', ')
            : '없음'}
        </dd>
        <dt>누적</dt>
        <dd>
          SYN 큐 넘침 {count(counters.listenOverflows)} · 드롭 {count(counters.listenDrops)} ·
          재전송 {count(counters.retransmitted)}
        </dd>
      </dl>
    </>
  );
}

function ProcessesSection({ runtime }: { runtime: Runtime }) {
  const groups = groupProcesses(runtime.processes);
  return (
    <>
      <h3>프로세스·워커</h3>
      <table className="kube-table">
        <thead>
          <tr>
            <th>이름</th>
            <th>수</th>
            <th>스레드</th>
            <th>FD</th>
            <th>실행</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.name}>
              <td className="kube-wrap">{group.name}</td>
              <td>{group.count}</td>
              <td>{group.threads}</td>
              <td>
                {group.fds ?? '-'}
                {group.fdLimit !== null && ` / ${group.fdLimit}`}
              </td>
              <td>{formatAgeSeconds(group.oldestSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {runtime.truncated && <p className="kube-panel-note">프로세스가 많아 일부만 읽었습니다.</p>}
      <details className="kube-runtime-each">
        <summary>프로세스별 보기</summary>
        <table className="kube-table">
          <tbody>
            {runtime.processes.map((item) => (
              <tr key={item.pid}>
                <td>{item.pid}</td>
                <td className="kube-wrap">{item.name}</td>
                <td>{item.state}</td>
                <td>스레드 {item.threads}</td>
                <td>
                  FD {item.fds ?? '-'}
                  {item.fdLimit !== null && ` / ${item.fdLimit}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

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
        setCollected((now) => ({ current: runtime, previous: now?.current ?? null }));
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
    <div className="kube-info kube-runtime">
      <ThreadsSection read={threads.data} loading={threads.loading} />
      <div className="kube-panel-tools">
        <strong>파드 안에서 읽기</strong>
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
      </div>
      {note && (
        <p className="kube-panel-note kube-runtime-note" role="status">
          {note}
        </p>
      )}
      {collected && (
        <>
          <ProcessesSection runtime={collected.current} />
          <ConnectionsSection collected={collected} />
        </>
      )}
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
