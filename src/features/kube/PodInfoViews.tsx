import { useEffect, useRef, useState } from 'react';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import type { ContainerDetail, PodOverview, PodRef, Section } from './detailTypes';
import { filterLines, formatTime } from './podPanel';
import { stateNote } from './polling';
import { formatCpu, formatMemory } from './treeFormat';
import { detailNote, readDetail, useKubeRead } from './useKubeRead';

export type UsageSample = { cpu: number; memory: number };

const stateText = (c: ContainerDetail) =>
  c.state === 'running' ? '실행 중' : c.reason || c.state || '알 수 없음';

function Trend({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const points = values
    .map((value, at) => `${(at * 100) / (values.length - 1)},${24 - (value / max) * 22}`)
    .join(' ');
  return (
    <svg
      className="kube-trend"
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label} 최근 ${values.length}개 표본`}
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--chart-series-1)"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

const quantity = (value: number | null, format: (n: number) => string) =>
  value === null ? '없음' : format(value);

function usageLine(
  used: number | undefined,
  request: number | null,
  limit: number | null,
  format: (n: number) => string,
) {
  const base = `요청 ${quantity(request, format)} · 제한 ${quantity(limit, format)}`;
  if (used === undefined) return base;
  const ratio = limit ? ` (제한의 ${Math.round((used / limit) * 100)}%)` : '';
  return `사용 ${format(used)}${ratio} · ${base}`;
}

const sum = (items: ContainerDetail[], pick: (c: ContainerDetail) => number | null) => {
  const values = items.map(pick).filter((value): value is number => value !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
};

export function OverviewView({
  overview,
  usage,
  trend,
}: {
  overview: PodOverview;
  usage: UsageSample | null;
  trend: UsageSample[];
}) {
  const { containers } = overview;
  return (
    <div className="kube-info">
      <dl className="kube-facts">
        <dt>상태</dt>
        <dd>{overview.reason || overview.phase}</dd>
        <dt>노드</dt>
        <dd>{overview.node || '미배정'}</dd>
        <dt>IP</dt>
        <dd>{overview.podIp || '없음'}</dd>
        <dt>만든 시각</dt>
        <dd>{formatTime(overview.created)}</dd>
        <dt>CPU</dt>
        <dd>
          {usageLine(
            usage?.cpu,
            sum(containers, (c) => c.cpuRequest),
            sum(containers, (c) => c.cpuLimit),
            formatCpu,
          )}
          <Trend values={trend.map((sample) => sample.cpu)} label="CPU" />
        </dd>
        <dt>메모리</dt>
        <dd>
          {usageLine(
            usage?.memory,
            sum(containers, (c) => c.memoryRequest),
            sum(containers, (c) => c.memoryLimit),
            formatMemory,
          )}
          <Trend values={trend.map((sample) => sample.memory)} label="메모리" />
        </dd>
      </dl>
      <table className="kube-table">
        <thead>
          <tr>
            <th>컨테이너</th>
            <th>이미지</th>
            <th>상태</th>
            <th>재시작</th>
            <th>마지막 종료</th>
          </tr>
        </thead>
        <tbody>
          {[...overview.initContainers, ...containers].map((c) => (
            <tr key={c.name}>
              <td>{c.name}</td>
              <td className="kube-wrap">{c.image}</td>
              <td>{stateText(c)}</td>
              <td>{c.restarts}</td>
              <td>
                {c.last &&
                  `${c.last.reason} (${c.last.exitCode ?? '?'}) ${formatTime(c.last.finishedAt)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type ReadProps = { connectionId: string; kube: KubeSettings; target: PodRef; tick: number };
const readKey = ({ target, tick }: ReadProps) => `${target.namespace}/${target.name}/${tick}`;

export function EventsView(props: ReadProps) {
  const { connectionId, kube, target } = props;
  const read = useKubeRead(() => readDetail(connectionId, kube, target, 'events'), readKey(props));
  const items = read.data?.data?.kind === 'events' ? read.data.data.items : [];
  const note = detailNote(read.data, read.error);
  return (
    <div className="kube-info">
      {read.loading && <p className="kube-panel-note">이벤트를 읽는 중…</p>}
      {note && <p className="kube-panel-note">{note}</p>}
      {!read.loading && !note && items.length === 0 && (
        <p className="kube-panel-note">이벤트가 없습니다. 이벤트는 기본 1시간만 보관됩니다.</p>
      )}
      {items.length > 0 && (
        <table className="kube-table">
          <thead>
            <tr>
              <th>시각</th>
              <th>유형</th>
              <th>사유</th>
              <th>횟수</th>
              <th>메시지</th>
            </tr>
          </thead>
          <tbody>
            {items.map((event, at) => (
              <tr key={`${event.time}-${at}`}>
                <td>{formatTime(event.time)}</td>
                <td>{event.eventType}</td>
                <td>{event.reason}</td>
                <td>{event.count || ''}</td>
                <td className="kube-wrap">{event.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Read-only and held in memory only: the text can contain values from environment variables. */
export function YamlView(props: ReadProps) {
  const { connectionId, kube, target } = props;
  const read = useKubeRead(() => readDetail(connectionId, kube, target, 'yaml'), readKey(props));
  const text = read.data?.data?.kind === 'yaml' ? read.data.data.text : '';
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState('');
  const body = useRef<HTMLPreElement>(null);
  const shown = query ? filterLines(text, query).join('\n') : text;
  const note = detailNote(read.data, read.error);
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [query]);
  return (
    <div className="kube-log-view">
      <div className="kube-panel-tools">
        <input
          type="search"
          aria-label="YAML 검색"
          placeholder="YAML 줄 검색"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          disabled={!text}
          onClick={() =>
            void call('clipboard_write_text', { text }).then(
              () => setCopied('복사했습니다.'),
              (e: unknown) => setCopied(errorText(e)),
            )
          }
        >
          복사
        </button>
        {copied && <span className="kube-panel-note">{copied}</span>}
      </div>
      {note && <p className="kube-panel-note">{note}</p>}
      {read.loading && <p className="kube-panel-note">YAML을 읽는 중…</p>}
      <pre ref={body} className="kube-log" tabIndex={0} aria-label="YAML">
        {shown}
      </pre>
    </div>
  );
}

function SectionList<T>({
  title,
  section,
  empty,
  render,
}: {
  title: string;
  section: Section<T>;
  empty: string;
  render: (item: T) => string;
}) {
  const failed = section.state.kind !== 'ready';
  return (
    <>
      <h3>{title}</h3>
      {failed && <p className="kube-panel-note">{stateNote(section.state)}</p>}
      {!failed && section.items.length === 0 && <p className="kube-panel-note">{empty}</p>}
      <ul>
        {section.items.map((item) => (
          <li key={render(item)}>{render(item)}</li>
        ))}
      </ul>
    </>
  );
}

const rotation = (value: boolean | null) =>
  value === true
    ? '로테이션 포함'
    : value === false
      ? '로테이션 제외(준비 안 됨)'
      : '엔드포인트 없음';

export function RelationsView(props: ReadProps) {
  const { connectionId, kube, target } = props;
  const read = useKubeRead(
    () => readDetail(connectionId, kube, target, 'relations'),
    readKey(props),
  );
  const data = read.data?.data?.kind === 'relations' ? read.data.data : null;
  const note = detailNote(read.data, read.error);
  return (
    <div className="kube-info">
      {read.loading && <p className="kube-panel-note">관계를 읽는 중…</p>}
      {note && <p className="kube-panel-note">{note}</p>}
      {data && (
        <>
          <SectionList
            title="Service"
            section={data.services}
            empty="이 파드를 고르는 Service가 없습니다."
            render={(item) => `${item.name} · ${rotation(item.inRotation)}`}
          />
          <SectionList
            title="Ingress"
            section={data.ingresses}
            empty="연결된 Ingress가 없습니다."
            render={(item) =>
              `${item.name} · ${item.hosts.join(', ') || '호스트 없음'} → ${item.services.join(', ')}`
            }
          />
          <SectionList
            title="NetworkPolicy"
            section={data.networkPolicies}
            empty="적용되는 NetworkPolicy가 없습니다."
            render={(item) => item}
          />
          <h3>PVC</h3>
          {data.pvcs.length === 0 && <p className="kube-panel-note">없음</p>}
          <ul>
            {data.pvcs.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <h3>ConfigMap</h3>
          {data.configMaps.length === 0 && <p className="kube-panel-note">없음</p>}
          <ul>
            {data.configMaps.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
