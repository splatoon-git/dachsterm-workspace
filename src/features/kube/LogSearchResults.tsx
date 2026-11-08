import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MenuPoint } from '../../components/ContextMenu';
import {
  displayRows,
  highlightParts,
  rowTime,
  type DisplayRow,
  type SearchRow,
} from './logSearchModel';
import { visibleRange } from './treeFormat';

const ROW_HEIGHT = 24;

function Row({
  item,
  top,
  words,
  active,
  select,
  menu,
}: {
  item: DisplayRow;
  top: number;
  words: string[];
  active: boolean;
  select: (row: SearchRow) => void;
  menu: (row: SearchRow, at: MenuPoint) => void;
}) {
  if (item.type === 'group')
    return (
      <div className="kube-search-row group" role="row" style={{ top }}>
        <span role="cell">
          {item.label} <small>{item.count.toLocaleString('en-US')}줄</small>
        </span>
      </div>
    );
  const { row } = item;
  return (
    <div
      className={`kube-search-row ${active ? 'active' : ''}`}
      role="row"
      aria-selected={active}
      style={{ top }}
      onClick={() => select(row)}
      onContextMenu={(event) => {
        event.preventDefault();
        select(row);
        menu(row, { x: event.clientX, y: event.clientY });
      }}
    >
      <span role="cell">{rowTime(row.at)}</span>
      <span role="cell" title={`${row.namespace}/${row.pod}`}>
        {row.pod}
      </span>
      <span role="cell">
        {row.container}
        {row.previous && <small> 이전</small>}
      </span>
      <span role="cell" className="kube-search-text" title={row.text}>
        {highlightParts(row.text, words).map((part, at) =>
          part.hit ? <mark key={at}>{part.text}</mark> : <span key={at}>{part.text}</span>,
        )}
        {row.clipped && <small> …잘림</small>}
      </span>
    </div>
  );
}

/** A virtual list, because a search can return thousands of lines. */
export function LogSearchResults({
  rows,
  words,
  descending,
  byPod,
  activeId,
  select,
  menu,
  toggleOrder,
}: {
  rows: SearchRow[];
  words: string[];
  descending: boolean;
  byPod: boolean;
  activeId: number | null;
  select: (row: SearchRow) => void;
  menu: (row: SearchRow, at: MenuPoint) => void;
  toggleOrder: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 400 });
  const shown = useMemo(() => displayRows(rows, descending, byPod), [rows, descending, byPod]);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => setScroll((now) => ({ ...now, height: element.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const range = visibleRange(scroll.top, scroll.height, ROW_HEIGHT, shown.length);
  return (
    <div className="kube-search-results" role="table" aria-label="로그 검색 결과">
      <div className="kube-search-row head" role="row">
        <span role="columnheader" className="kube-tree-sort" onClick={toggleOrder}>
          시각 {descending ? '↓' : '↑'}
        </span>
        <span role="columnheader">파드</span>
        <span role="columnheader">컨테이너</span>
        <span role="columnheader">내용</span>
      </div>
      <div
        ref={body}
        className="kube-search-body"
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          setScroll((now) => (now.top === top ? now : { ...now, top }));
        }}
      >
        <div style={{ height: shown.length * ROW_HEIGHT, position: 'relative' }}>
          {shown.slice(range.first, range.last).map((item, offset) => (
            <Row
              key={item.key}
              item={item}
              top={(range.first + offset) * ROW_HEIGHT}
              words={words}
              active={item.type === 'line' && item.row.id === activeId}
              select={select}
              menu={menu}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
