import { useEffect, useState } from 'react';
import { MetricChart } from '../../components/MetricChart';
import {
  formatCount,
  formatMemory,
  formatPercent,
  formatPlain,
  formatSeconds,
  statusText,
} from './aiFormat';
import {
  ALL_MODELS,
  NO_MODEL_LABEL,
  type GpuNode,
  type ModelGroup,
  type PodGpu,
  type PodRow,
  type Trend,
} from './aiModel';
import type { ModelValues } from './aiValues';
import type { PodRef } from './detailTypes';
import { stateNote } from './polling';
import { useWorkers } from './workerContext';
import { verdictLine } from './workers';
import './kubeAi.css';

const COLUMNS = 13;

function ValueCells({ values, gpu }: { values: ModelValues; gpu: PodGpu | null }) {
  return (
    <>
      <td>{formatCount(values.run)}</td>
      <td className={values.wait ? 'warn' : undefined}>{formatCount(values.wait)}</td>
      <td>{values.doneDelta === null ? '-' : `+${formatCount(values.doneDelta)}`}</td>
      <td>{formatCount(values.donePerMinute)}</td>
      <td>{formatPercent(values.kv)}</td>
      <td>{formatCount(values.outputRate)}</td>
      <td>{formatCount(values.inputRate)}</td>
      <td>{formatSeconds(values.ttft)}</td>
      <td>{formatSeconds(values.e2e)}</td>
      <td>{formatSeconds(values.queue)}</td>
      <td>{formatPercent(gpu?.util ?? null)}</td>
      <td>{formatMemory(gpu?.used ?? null, gpu?.total ?? null)}</td>
    </>
  );
}

function PodLine({
  row,
  now,
  openRuntime,
}: {
  row: PodRow;
  now: number;
  openRuntime: (pod: PodRef) => void;
}) {
  return (
    <tr className={row.stalled ? 'warn' : undefined}>
      <td className="kube-ai-name">
        <button
          type="button"
          className="kube-ai-pod"
          title={`${row.namespace}/${row.pod} · ${row.node}`}
          onClick={() => openRuntime({ namespace: row.namespace, name: row.pod })}
        >
          {row.pod}
        </button>
        {row.stalled && <em> ⚠ {verdictLine(row.stalled, now)}</em>}
      </td>
      {row.values ? (
        <ValueCells values={row.values} gpu={row.gpu} />
      ) : (
        <td colSpan={COLUMNS - 1} className="kube-ai-failed" title={row.endpoint}>
          {statusText[row.status]}
        </td>
      )}
    </tr>
  );
}

function ModelLines({
  group,
  now,
  folded,
  toggle,
  openRuntime,
}: {
  group: ModelGroup;
  now: number;
  folded: boolean;
  toggle: () => void;
  openRuntime: (pod: PodRef) => void;
}) {
  const name = group.model || NO_MODEL_LABEL;
  return (
    <>
      <tr className="kube-ai-model">
        <td className="kube-ai-name">
          <button type="button" aria-expanded={!folded} onClick={toggle} title={name}>
            <span aria-hidden="true">{folded ? '▸' : '▾'}</span> {name}
          </button>
          <span className={group.ok < group.rows.length ? 'kube-ai-short' : 'kube-ai-count'}>
            {' '}
            {group.ok}/{group.rows.length}
          </span>
        </td>
        <ValueCells values={group.values} gpu={group.gpu} />
      </tr>
      {!folded &&
        group.rows.map((row) => (
          <PodLine key={row.key} row={row} now={now} openRuntime={openRuntime} />
        ))}
    </>
  );
}

function Trends({ trend }: { trend: Trend | undefined }) {
  if (!trend) return null;
  const top = (values: (number | null)[]) => Math.max(1, ...values.map((v) => v ?? 0));
  return (
    <div className="kube-ai-charts">
      <MetricChart label="실행" values={trend.run} unit="" max={top(trend.run)} color={1} />
      <MetricChart label="대기" values={trend.wait} unit="" max={top(trend.wait)} color={2} />
      <MetricChart
        label="분당 완료"
        values={trend.donePerMinute}
        unit=""
        max={top(trend.donePerMinute)}
        color={3}
      />
      <MetricChart label="KV 캐시" values={trend.kv} unit="%" max={100} color={4} />
    </div>
  );
}

function GpuSection({
  nodes,
  folded,
  toggle,
}: {
  nodes: GpuNode[];
  folded: Set<string>;
  toggle: (key: string) => void;
}) {
  return (
    <section aria-label="GPU">
      <h3>GPU</h3>
      <table className="kube-table kube-ai-table">
        <thead>
          <tr>
            <th>노드·장치</th>
            <th>사용률</th>
            <th>VRAM</th>
            <th>온도</th>
            <th>전력</th>
            <th>파드</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => {
            const closed = folded.has(`gpu:${node.node}`);
            return (
              <NodeLines
                key={node.node}
                node={node}
                closed={closed}
                toggle={() => toggle(`gpu:${node.node}`)}
              />
            );
          })}
        </tbody>
      </table>
      <p className="kube-panel-note">GPU 값은 공유 여부와 관계없이 장치 전체 기준입니다.</p>
    </section>
  );
}

function NodeLines({
  node,
  closed,
  toggle,
}: {
  node: GpuNode;
  closed: boolean;
  toggle: () => void;
}) {
  return (
    <>
      <tr className="kube-ai-model">
        <td className="kube-ai-name">
          <button type="button" aria-expanded={!closed} onClick={toggle} title={node.node}>
            <span aria-hidden="true">{closed ? '▸' : '▾'}</span> {node.node}
          </button>
          <span className="kube-ai-count"> GPU {node.devices.length}개</span>
        </td>
        <td>
          평균 {formatPercent(node.utilAverage)} · 최대 {formatPercent(node.utilMax)}
        </td>
        <td>{formatMemory(node.used, node.total)}</td>
        <td>{formatPlain(node.tempMax, '°C')}</td>
        <td>{formatPlain(node.power, 'W')}</td>
        <td />
      </tr>
      {!closed &&
        node.devices.map((device) => (
          <tr key={device.id}>
            <td className="kube-ai-name">
              <span className="kube-ai-device" title={device.id}>
                #{device.gpu || '-'} {device.model || 'GPU'}
              </span>
            </td>
            <td>{formatPercent(device.util)}</td>
            <td>{formatMemory(device.used, device.total)}</td>
            <td>{formatPlain(device.temp, '°C')}</td>
            <td>{formatPlain(device.power, 'W')}</td>
            <td className="kube-wrap">{device.pods.join(', ') || '-'}</td>
          </tr>
        ))}
    </>
  );
}

/** Model > pod table with trends and the GPU devices. Everything shown here was read by `kube_ai`. */
export function KubeAi({ openRuntime }: { openRuntime: (pod: PodRef) => void }) {
  const { ai } = useWorkers();
  const { setFast, view, read, trends, error } = ai;
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [chosen, setChosen] = useState(ALL_MODELS);
  useEffect(() => {
    setFast(true);
    return () => setFast(false);
  }, [setFast]);

  const toggle = (key: string) =>
    setFolded((now) => {
      const next = new Set(now);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const groups = view?.groups ?? [];
  const failedExporters = read?.exporters.filter((item) => item.status !== 'ok') ?? [];
  const trendKey = chosen in trends ? chosen : ALL_MODELS;
  const notReady = read && read.state.kind !== 'ready' ? stateNote(read.state) : '';

  return (
    <div className="kube-ai">
      <div className="kube-ai-summary">
        <strong>실행 {formatCount(view?.all.run ?? null)}</strong>
        <strong>대기 {formatCount(view?.all.wait ?? null)}</strong>
        <span>분당 완료 {formatCount(view?.all.donePerMinute ?? null)}</span>
        <span>출력 {formatCount(view?.all.outputRate ?? null)} tok/s</span>
        <span>KV {formatPercent(view?.all.kv ?? null)}</span>
        <span className="kube-ai-hint">실행·대기는 추론 요청 수입니다.</span>
      </div>
      {error && <p role="alert">{error}</p>}
      {notReady && (
        <p className="kube-panel-note" role="status">
          {notReady}
        </p>
      )}
      {!view && !notReady && !error && <p className="kube-panel-note">vLLM·GPU 파드를 찾는 중…</p>}
      {view && groups.length === 0 && view.nodes.length === 0 && (
        <p className="kube-panel-note">vLLM·GPU 파드를 찾지 못했습니다.</p>
      )}
      {read && read.capped > 0 && (
        <p className="kube-panel-note">대상이 많아 {read.capped}개는 읽지 않습니다.</p>
      )}
      {read?.gpuRestricted && (
        <p className="kube-panel-note">
          다른 namespace의 GPU exporter를 조회할 권한이 없어 일부만 표시합니다.
        </p>
      )}
      {groups.length > 0 && (
        <>
          <table className="kube-table kube-ai-table">
            <thead>
              <tr>
                <th>모델·파드</th>
                <th>실행</th>
                <th>대기</th>
                <th>완료</th>
                <th>분당</th>
                <th>KV</th>
                <th>출력 tok/s</th>
                <th>입력 tok/s</th>
                <th>첫 토큰</th>
                <th>응답</th>
                <th>큐 대기</th>
                <th>GPU</th>
                <th>VRAM</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <ModelLines
                  key={group.model}
                  group={group}
                  now={view?.at ?? 0}
                  folded={folded.has(group.model)}
                  toggle={() => toggle(group.model)}
                  openRuntime={openRuntime}
                />
              ))}
            </tbody>
          </table>
          <div className="kube-ai-trend-head">
            <h3>추이</h3>
            <select
              aria-label="추이 모델"
              value={trendKey}
              onChange={(event) => setChosen(event.target.value)}
            >
              <option value={ALL_MODELS}>모든 모델</option>
              {groups.map((group) => (
                <option key={group.model} value={group.model}>
                  {group.model || NO_MODEL_LABEL}
                </option>
              ))}
            </select>
          </div>
          <Trends trend={trends[trendKey]} />
        </>
      )}
      {view && view.nodes.length > 0 && (
        <GpuSection nodes={view.nodes} folded={folded} toggle={toggle} />
      )}
      {failedExporters.map((item) => (
        <p key={`${item.namespace}/${item.pod}`} className="kube-panel-note" title={item.endpoint}>
          GPU exporter {item.namespace}/{item.pod}: {statusText[item.status]}
        </p>
      ))}
    </div>
  );
}
