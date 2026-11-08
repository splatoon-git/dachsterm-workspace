import { useLayoutEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { call, type KubeSettings } from '../../lib/ipc';
import type { PodLogs } from './detailTypes';
import {
  aroundLines,
  aroundSince,
  highlightParts,
  rowTime,
  logTimeMs,
  type SearchRow,
} from './logSearchModel';
import { stateNote } from './polling';
import { useKubeRead } from './useKubeRead';

/** The log around one search result. Read when it is opened and never kept. */
export function LogAround({
  connectionId,
  kube,
  row,
  count,
  words,
  close,
  style,
}: {
  connectionId: string;
  kube: KubeSettings;
  row: SearchRow;
  count: number;
  words: string[];
  close: () => void;
  style?: CSSProperties;
}) {
  const hit = useRef<HTMLDivElement>(null);
  const read = useKubeRead(
    () =>
      call<PodLogs>('kube_logs', {
        id: connectionId,
        kube,
        target: { namespace: row.namespace, pod: row.pod },
        container: row.container,
        tail: 1,
        previous: row.previous,
        sinceTime: aroundSince(row),
      }),
    `${row.id}`,
  );
  const shown = useMemo(
    () => (read.data ? aroundLines(read.data.text, row, count) : null),
    [read.data, row, count],
  );
  useLayoutEffect(() => {
    hit.current?.scrollIntoView({ block: 'center' });
  }, [shown]);
  const failed =
    read.error || (read.data && read.data.state.kind !== 'ready' ? stateNote(read.data.state) : '');
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== 'Escape') return;
    event.preventDefault();
    close();
  };
  return (
    <section
      className="kube-panel kube-around"
      style={style}
      aria-label="주변 로그"
      onKeyDown={onKeyDown}
    >
      <div className="kube-panel-head">
        <strong title={`${row.namespace}/${row.pod}`}>{row.pod}</strong>
        <span className="kube-panel-namespace">
          {row.container}
          {row.previous ? ' · 이전 인스턴스' : ''}
        </span>
        <button aria-label="패널 닫기" title="닫기 (Esc)" onClick={close}>
          ×
        </button>
      </div>
      <div className="kube-panel-note" role="status">
        {read.loading && '주변 로그를 읽는 중…'}
        {failed}
        {shown && shown.marked < 0 && !failed && '이 줄을 찾지 못해 가까운 시각의 줄을 표시합니다.'}
        {read.data?.truncated && ' 로그가 커서 일부만 읽었습니다.'}
      </div>
      <div className="kube-around-lines" tabIndex={0} aria-label="주변 로그 내용">
        {shown?.lines.map((line, at) => (
          <div
            key={at}
            ref={at === shown.marked ? hit : undefined}
            className={`kube-around-line ${at === shown.marked ? 'hit' : ''}`}
          >
            <small>{rowTime(logTimeMs(line.time))}</small>
            <span>
              {highlightParts(line.text, at === shown.marked ? words : []).map((part, index) =>
                part.hit ? (
                  <mark key={index}>{part.text}</mark>
                ) : (
                  <span key={index}>{part.text}</span>
                ),
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
