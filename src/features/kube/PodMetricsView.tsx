import { useMemo, useState, type FormEvent } from 'react';
import {
  ContextMenu,
  anchorBelow,
  isMenuKey,
  type MenuRequest,
} from '../../components/ContextMenu';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import type { PodOverview, PodRef } from './detailTypes';
import { stateNote } from './polling';
import {
  candidateLabel,
  formatMetric,
  metricRows,
  parsePort,
  roleLabels,
  roleNames,
  shownMetricRows,
  type MetricRow,
  type RoleName,
} from './runtimeModel';
import type { MetricCandidate, MetricSource, MetricsRead } from './runtimeTypes';
import { ownerOf } from './tree';
import { useKubeRead } from './useKubeRead';
import { useWorkers } from './workerContext';
import { WATCH_CONCURRENCY } from './workerSchedule';
import { DEFAULT_MINUTES, MAX_MINUTES, MIN_MINUTES, metricReadNote } from './workers';

type Checked = { candidate: MetricCandidate; note: string; count: number | null };
type Discovery = { checked: Checked[]; note: string };
type Listing = { rows: MetricRow[] | null; total: number; note: string };
type MetricsCall = (metrics: object) => Promise<MetricsRead>;

const toSource = ({ port, path, https }: MetricSource): MetricSource => ({ port, path, https });

const sameSource = (a: MetricSource | null, b: MetricSource) =>
  a?.port === b.port && a.path === b.path && a.https === b.https;

/** The candidates in the pod's spec, each tried without reading its whole answer. */
async function discover(metricsCall: MetricsCall): Promise<Discovery> {
  const answer = await metricsCall({ kind: 'candidates' });
  if (answer.state.kind !== 'ready' || answer.data?.kind !== 'candidates')
    return { checked: [], note: stateNote(answer.state) };
  const items = answer.data.items;
  const checked: Checked[] = items.map((candidate) => ({ candidate, note: '', count: null }));
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      const read = await metricsCall({ kind: 'pod', ...toSource(items[index]), only: [] }).catch(
        (error: unknown): MetricsRead => ({
          state: { kind: 'unknown', message: errorText(error) },
          data: null,
          elapsedMs: 0,
        }),
      );
      checked[index] = {
        candidate: items[index],
        note: metricReadNote(read),
        count: read.data?.kind === 'series' ? read.data.total : null,
      };
    }
  };
  await Promise.all(Array.from({ length: WATCH_CONCURRENCY }, worker));
  return { checked, note: '' };
}

async function readListing(metricsCall: MetricsCall, source: MetricSource): Promise<Listing> {
  const read = await metricsCall({ kind: 'pod', ...source, only: null });
  const note = metricReadNote(read);
  if (note || read.data?.kind !== 'series') return { rows: null, total: 0, note };
  return { rows: metricRows(read.data.items), total: read.data.total, note: '' };
}

/** Finds where the pod serves metrics, lets the user read one, and turns watching on or off. */
export function PodMetricsView({
  connectionId,
  kube,
  target,
  overview,
  workloadKey,
  container,
  tick,
  requestConsent,
}: {
  connectionId: string;
  kube: KubeSettings;
  target: PodRef;
  overview: PodOverview;
  workloadKey: string;
  container: string;
  tick: number;
  requestConsent: (then: () => void) => void;
}) {
  const workers = useWorkers();
  const watch = workers.watchOf(workloadKey);
  const [chosen, setChosen] = useState<MetricSource | null>(
    watch?.metrics ? toSource(watch.metrics) : null,
  );
  const [readCount, setReadCount] = useState(0);
  const [port, setPort] = useState('');
  const [path, setPath] = useState('/metrics');
  const [portNote, setPortNote] = useState('');
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [roles, setRoles] = useState<Partial<Record<RoleName, string>>>(
    watch?.metrics?.roles ?? {},
  );
  const [minutes, setMinutes] = useState(String(watch?.minutes ?? DEFAULT_MINUTES));
  const [repeatProbe, setRepeatProbe] = useState(Boolean(watch?.probe));
  const pod = { namespace: target.namespace, pod: target.name };
  const metricsCall = (metrics: object) =>
    call<MetricsRead>('kube_metrics', { id: connectionId, kube, target: { ...metrics, ...pod } });

  const podKey = `${target.namespace}/${target.name}`;
  const discovery = useKubeRead(() => discover(metricsCall), `${podKey}/${tick}`);
  const checked = discovery.data?.checked ?? null;
  const listNote = discovery.error || (discovery.data?.note ?? '');
  const found = checked?.find((item) => item.count !== null)?.candidate;
  const source = chosen ?? (found ? toSource(found) : null);
  const listing = useKubeRead(
    () => (source ? readListing(metricsCall, source) : Promise.resolve(null)),
    `${podKey}/${source?.port}${source?.path}${source?.https}/${tick}/${readCount}`,
  );
  const series = listing.data?.rows ?? null;
  const total = listing.data?.total ?? 0;
  const readNote = portNote || listing.error || (listing.data?.note ?? '');
  const reading = source !== null && listing.loading;

  const read = (next: MetricSource) => {
    setPortNote('');
    setChosen(toSource(next));
    setReadCount((count) => count + 1);
  };

  const pins = workers.pinsOf(workloadKey);
  const shown = useMemo(
    () => (series ? shownMetricRows(series, query, pins) : null),
    [series, query, pins],
  );

  const openMenu = (row: MetricRow, at: { x: number; y: number }) =>
    setMenu({
      at,
      items: [
        ...roleNames.map((role) => ({
          label: `${roleLabels[role]}(으)로 지정`,
          run: () => setRoles((now) => ({ ...now, [role]: row.selector })),
        })),
        {
          label: pins.includes(row.selector) ? '고정 해제' : '위에 고정',
          separated: true,
          run: () => workers.togglePin(workloadKey, row.selector),
        },
      ],
    });

  const submitManual = (event: FormEvent) => {
    event.preventDefault();
    const number = parsePort(port);
    if (number === null) {
      setPortNote('포트 번호를 확인하세요.');
      return;
    }
    read({ port: number, path: path.trim(), https: false });
  };

  const owner = ownerOf(overview);
  const parsedMinutes = Number(minutes);
  const minutesValid =
    Number.isInteger(parsedMinutes) && parsedMinutes >= MIN_MINUTES && parsedMinutes <= MAX_MINUTES;
  const complete = source && roleNames.every((role) => roles[role]);
  const canWatch = owner && minutesValid && (complete || repeatProbe);

  const startWatch = () => {
    if (!owner || !minutesValid) return;
    const metrics =
      complete && source
        ? {
            ...source,
            roles: {
              busy: roles.busy ?? '',
              total: roles.total ?? '',
              completed: roles.completed ?? '',
            },
          }
        : null;
    const apply = () =>
      workers.setWatch({
        key: workloadKey,
        namespace: target.namespace,
        kind: owner.kind,
        name: owner.name,
        minutes: parsedMinutes,
        metrics,
        probe: repeatProbe && container ? { container } : null,
      });
    if (repeatProbe) requestConsent(apply);
    else apply();
  };

  return (
    <section className="kube-metrics" aria-label="앱 메트릭">
      <h3>앱 메트릭</h3>
      {checked === null && !listNote && <p className="kube-panel-note">후보를 확인하는 중…</p>}
      {listNote && <p className="kube-panel-note">{listNote}</p>}
      {checked?.length === 0 && !listNote && (
        <p className="kube-panel-note">선언된 포트가 없습니다. 아래에 직접 입력하세요.</p>
      )}
      {checked && checked.length > 0 && (
        <ul className="kube-metrics-candidates" aria-label="메트릭 후보">
          {checked.map(({ candidate, note, count }) => {
            const label = candidateLabel(candidate);
            const status = count !== null ? `지표 ${count}개` : note || '확인 중…';
            return (
              <li key={label}>
                <button
                  aria-pressed={sameSource(source, candidate)}
                  disabled={count === null}
                  onClick={() => read(candidate)}
                >
                  {label}
                </button>
                <span>{status}</span>
                {candidate.annotated && <small>annotation</small>}
              </li>
            );
          })}
        </ul>
      )}
      <form className="kube-panel-tools" onSubmit={submitManual}>
        <input
          aria-label="메트릭 포트"
          inputMode="numeric"
          placeholder="포트"
          value={port}
          onChange={(event) => setPort(event.target.value)}
        />
        <input
          aria-label="메트릭 경로"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <button type="submit" disabled={reading}>
          읽기
        </button>
      </form>
      {reading && <p className="kube-panel-note">메트릭을 읽는 중…</p>}
      {readNote && (
        <p className="kube-panel-note" role="status">
          {readNote}
        </p>
      )}
      {shown && (
        <>
          <div className="kube-panel-tools">
            <input
              type="search"
              aria-label="메트릭 필터"
              placeholder="필터: 공백은 AND, !단어는 제외"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <span className="kube-panel-note">전체 {total}개</span>
          </div>
          <ul className="kube-metrics-list" aria-label="메트릭 목록">
            {shown.rows.map((row) => (
              <li key={row.selector}>
                <button
                  title={row.selector}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openMenu(row, { x: event.clientX, y: event.clientY });
                  }}
                  onKeyDown={(event) => {
                    if (!isMenuKey(event)) return;
                    event.preventDefault();
                    openMenu(row, anchorBelow(event.currentTarget));
                  }}
                >
                  <span>
                    {pins.includes(row.selector) && '★ '}
                    {row.name}
                    {row.labels && <small>{`{${row.labels}}`}</small>}
                    {row.series > 1 && <small> 합계 · {row.series}개</small>}
                  </span>
                  <span>{formatMetric(row.value)}</span>
                </button>
              </li>
            ))}
          </ul>
          {shown.more > 0 && (
            <p className="kube-panel-note">외 {shown.more}개는 필터로 좁혀서 보세요.</p>
          )}
          <p className="kube-panel-note">우클릭으로 사용 중, 전체, 완료 수를 지정합니다.</p>
        </>
      )}
      <h3>워커 감시</h3>
      {!owner && <p className="kube-panel-note">워크로드에 속한 파드만 감시할 수 있습니다.</p>}
      {owner && (
        <>
          <dl className="kube-facts">
            {roleNames.map((role) => (
              <div key={role} className="kube-metrics-role">
                <dt>{roleLabels[role]}</dt>
                <dd className="kube-wrap">{roles[role] ?? '지정 안 됨'}</dd>
              </div>
            ))}
          </dl>
          <div className="kube-panel-tools">
            <label>
              기준{' '}
              <input
                aria-label="판정 기준(분)"
                type="number"
                min={MIN_MINUTES}
                max={MAX_MINUTES}
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
              />
              분
            </label>
            <label>
              <input
                type="checkbox"
                checked={repeatProbe}
                onChange={(event) => setRepeatProbe(event.target.checked)}
              />
              프로브도 30초마다 반복
            </label>
            <button className="primary" disabled={!canWatch} onClick={startWatch}>
              {watch ? '감시 설정 저장' : '워커 감시 켜기'}
            </button>
            {watch && <button onClick={() => workers.removeWatch(workloadKey)}>감시 끄기</button>}
          </div>
          <p className="kube-panel-note">
            사용 중·전체·완료 수를 지정하면 반환 판정이 켜집니다. 메트릭이 없으면 프로브만으로도
            감시할 수 있습니다.
          </p>
        </>
      )}
      {menu && (
        <ContextMenu
          label="메트릭 메뉴"
          at={menu.at}
          items={menu.items}
          close={() => setMenu(null)}
        />
      )}
    </section>
  );
}
