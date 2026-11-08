import { conclusionText, hopDevice, hopNote, hopTime, methodNote } from './routeTrace';
import type { Source } from './sourceLink';
import { useRouteTrace } from './useRouteTrace';

const sameSource = (a: Source, b: Source | null) => JSON.stringify(a) === JSON.stringify(b);

/** Inside the expanded result, and only runs when asked. */
export function RouteTraceSection({
  checkedFrom,
  source,
  host,
  port,
}: {
  checkedFrom: Source;
  source: Source | null;
  host: string;
  port: number;
}) {
  const { state, error, start, stop } = useRouteTrace();
  const usable = sameSource(checkedFrom, source);
  return (
    <div className="service-trace">
      <div className="service-trace-head">
        <span>경로 추적</span>
        <button
          type="button"
          disabled={!state.running && !usable}
          onClick={() => (state.running ? stop() : void start(checkedFrom, host, port))}
        >
          {state.running ? '취소' : '실행'}
        </button>
      </div>
      {!usable && !state.running && (
        <p className="tool-pending">출발지가 바뀌었습니다. 다시 점검한 뒤 실행하세요.</p>
      )}
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
      {state.method && <p className="tool-note">{methodNote[state.method]}</p>}
      {state.hops.length > 0 && (
        <table className="tool-results">
          <thead>
            <tr>
              <th>홉</th>
              <th>장비</th>
              <th>시간</th>
              <th>비고</th>
            </tr>
          </thead>
          <tbody>
            {state.hops.map((hop) => (
              <tr key={hop.hop}>
                <td>{hop.hop}</td>
                <td>{hopDevice(hop)}</td>
                <td>{hopTime(hop)}</td>
                <td className="tool-note">{hopNote(hop)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {state.running && <p className="tool-pending">추적 중…</p>}
      {state.cancelled && <p className="tool-pending">취소됨</p>}
      {state.conclusion && (
        <p className="service-conclusion" role="status">
          {conclusionText(state.conclusion)}
        </p>
      )}
      {state.note && <p className="tool-notice">{state.note}</p>}
    </div>
  );
}
