import { call, type KubeSettings } from '../../lib/ipc';
import type { PodLogs, PodOverview, PodRef } from './detailTypes';
import { causeContainer, causeRows, formatTime, importantEvents } from './podPanel';
import { stateNote } from './polling';
import { detailNote, readDetail, useKubeRead } from './useKubeRead';

const CAUSE_TAIL = 100;
const CAUSE_EVENTS = 10;

/** One screen that answers why: the reason and exit code, the events, and the last logs. */
export function PodCauseView({
  connectionId,
  kube,
  target,
  overview,
  tick,
}: {
  connectionId: string;
  kube: KubeSettings;
  target: PodRef;
  overview: PodOverview;
  tick: number;
}) {
  const container = causeContainer(overview);
  const events = useKubeRead(
    () => readDetail(connectionId, kube, target, 'events'),
    `${target.namespace}/${target.name}/${tick}`,
  );
  const logs = useKubeRead(
    () =>
      container
        ? call<PodLogs>('kube_logs', {
            id: connectionId,
            kube,
            target: { namespace: target.namespace, pod: target.name },
            container,
            tail: CAUSE_TAIL,
            previous: true,
          })
        : Promise.resolve(null),
    `${target.namespace}/${target.name}/${container}/${tick}`,
  );
  const rows = causeRows(overview);
  const eventItems = events.data?.data?.kind === 'events' ? events.data.data.items : [];
  const eventNote = detailNote(events.data, events.error);
  const logNote =
    logs.error || (logs.data && logs.data.state.kind !== 'ready' ? stateNote(logs.data.state) : '');
  return (
    <div className="kube-cause">
      <h3>사유</h3>
      {overview.reason && (
        <p>
          <strong>{overview.reason}</strong> {overview.message}
        </p>
      )}
      {rows.length === 0 && !overview.reason && <p className="kube-panel-note">문제가 없습니다.</p>}
      {rows.length > 0 && (
        <table className="kube-table">
          <thead>
            <tr>
              <th>컨테이너</th>
              <th>지금</th>
              <th>마지막 종료</th>
              <th>종료 코드</th>
              <th>시각</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.container} title={row.message || undefined}>
                <td>{row.container}</td>
                <td>{row.current}</td>
                <td>{row.reason}</td>
                <td>{row.exitCode ?? ''}</td>
                <td>{row.time ? formatTime(row.time) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>관련 이벤트</h3>
      {events.loading && <p className="kube-panel-note">이벤트를 읽는 중…</p>}
      {eventNote && <p className="kube-panel-note">{eventNote}</p>}
      {!events.loading && !eventNote && eventItems.length === 0 && (
        <p className="kube-panel-note">이벤트가 없습니다. 이벤트는 기본 1시간만 보관됩니다.</p>
      )}
      <ul className="kube-cause-events">
        {importantEvents(eventItems, CAUSE_EVENTS).map((event, at) => (
          <li key={`${event.time}-${at}`}>
            <time>{formatTime(event.time)}</time> <strong>{event.reason}</strong> {event.message}
          </li>
        ))}
      </ul>
      <h3>
        {logs.data?.previous === false ? '현재 로그' : '직전 인스턴스 로그'} · {container}
      </h3>
      <div className="kube-panel-note" role="status">
        {logs.loading && '로그를 읽는 중…'}
        {logNote}
        {logs.data?.previousMissing && '직전 인스턴스가 없어 현재 로그를 표시합니다.'}
      </div>
      <pre className="kube-log kube-cause-log" tabIndex={0} aria-label="장애 원인 로그">
        {logs.data?.text ?? ''}
      </pre>
    </div>
  );
}
