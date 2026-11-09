import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { clockTime, type BoardLine } from './logBoardModel';
import { highlightParts } from './logSearchModel';
import { visibleRange } from './treeFormat';

/** Heights of wrapped lines cannot be known ahead, so wrapping trades history for simplicity. */
const WRAPPED_LINES = 800;
const STUCK_MARGIN = 24;

export type LineTag = { text: string; color: string };

const Line = memo(function Line({
  line,
  tag,
  words,
  style,
}: {
  line: BoardLine;
  tag: LineTag | null;
  words: string[];
  style?: CSSProperties;
}) {
  return (
    <div className={`kube-line ${line.level}`} style={style}>
      <time>{clockTime(line.at)}</time>
      {tag && (
        <b className="kube-line-tag" style={{ color: tag.color }} title={line.key}>
          {tag.text}
        </b>
      )}
      <span className="kube-line-text">
        {words.length
          ? highlightParts(line.text, words).map((part, at) =>
              part.hit ? <mark key={at}>{part.text}</mark> : <span key={at}>{part.text}</span>,
            )
          : line.text}
      </span>
    </div>
  );
});

/** A virtual list that stays at the newest line until the user scrolls up. */
export function LogLines({
  lines,
  version,
  tagOf,
  words,
  fontSize,
  wrap,
  label,
}: {
  lines: BoardLine[];
  /** Changes when `lines`, which may be the same array, has new content. */
  version: number;
  tagOf: ((line: BoardLine) => LineTag | null) | null;
  words: string[];
  fontSize: number;
  wrap: boolean;
  label: string;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 400 });
  const [stuck, setStuck] = useState(true);
  const rowHeight = Math.round(fontSize * 1.55);
  const shown = wrap ? lines.slice(-WRAPPED_LINES) : lines;

  useLayoutEffect(() => {
    const element = body.current;
    if (element && stuck) element.scrollTop = element.scrollHeight;
  }, [version, stuck, shown.length, rowHeight, wrap]);

  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setScroll({ top: element.scrollTop, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const element = body.current;
    if (!element) return;
    setScroll({ top: element.scrollTop, height: element.clientHeight });
    setStuck(element.scrollHeight - element.scrollTop - element.clientHeight <= STUCK_MARGIN);
  };

  const { first, last } = wrap
    ? { first: 0, last: shown.length }
    : visibleRange(scroll.top, scroll.height, rowHeight, shown.length);
  return (
    <div className="kube-lines-frame">
      <div
        ref={body}
        className={`kube-lines ${wrap ? 'wrap' : ''}`}
        style={{ fontSize, lineHeight: `${rowHeight}px` }}
        tabIndex={0}
        role="log"
        aria-label={label}
        onScroll={onScroll}
      >
        {wrap ? (
          shown.map((line) => (
            <Line key={line.seq} line={line} tag={tagOf?.(line) ?? null} words={words} />
          ))
        ) : (
          <div className="kube-lines-space" style={{ height: shown.length * rowHeight }}>
            {shown.slice(first, last).map((line, offset) => (
              <Line
                key={line.seq}
                line={line}
                tag={tagOf?.(line) ?? null}
                words={words}
                style={{ top: (first + offset) * rowHeight, height: rowHeight }}
              />
            ))}
          </div>
        )}
      </div>
      {!stuck && (
        <button
          className="kube-lines-latest"
          onClick={() => {
            setStuck(true);
            body.current?.focus();
          }}
        >
          최신 로그로
        </button>
      )}
    </div>
  );
}
