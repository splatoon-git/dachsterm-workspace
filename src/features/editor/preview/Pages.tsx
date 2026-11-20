import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../../components/Icon';
import { FileTabBar } from '../TextDocument';
import { fittedScale, percent, scaleOf, steppedZoom, zoomSteps, type Zoom } from './zoom';
import './preview.css';

export type PageSize = { width: number; height: number };

/** Fitting a narrow page to a wide pane stops here, so text does not grow past easy reading. */
const widestFit = 1.5;

export function ZoomControls({
  zoom,
  scale,
  change,
}: {
  zoom: Zoom;
  scale: number;
  change: (next: Zoom) => void;
}) {
  const step = (direction: 1 | -1) =>
    change({ kind: 'scale', value: steppedZoom(scale, direction) });
  return (
    <div className="file-tab-switch preview-zoom" role="group" aria-label="확대와 축소">
      <button
        type="button"
        aria-label="축소"
        title="축소"
        disabled={scale <= zoomSteps[0]}
        onClick={() => step(-1)}
      >
        <Icon name="minus" size={12} />
      </button>
      <button type="button" title="100%로 보기" onClick={() => change({ kind: 'scale', value: 1 })}>
        {percent(scale)}
      </button>
      <button
        type="button"
        aria-label="확대"
        title="확대"
        disabled={scale >= zoomSteps[zoomSteps.length - 1]}
        onClick={() => step(1)}
      >
        <Icon name="plus" size={12} />
      </button>
      <button
        type="button"
        aria-pressed={zoom.kind === 'fit'}
        onClick={() => change({ kind: 'fit' })}
      >
        폭 맞춤
      </button>
    </div>
  );
}

/** The width and height inside an element's padding, kept current as it resizes. */
export function useRoom() {
  const element = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<PageSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => {
      const style = getComputedStyle(node);
      const width =
        node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height =
        node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      setRoom((old) => (old.width === width && old.height === height ? old : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [element, room] as const;
}

/**
 * A document of pages under one bar: zoom, a scrolling column of pages, and drawing only the
 * pages near what is visible. The viewers for PDF and 한글 files share it.
 */
export function PagedPreview({
  path,
  sizes,
  actions,
  children,
}: {
  path: string;
  /** Each page's size in CSS pixels at 100%. */
  sizes: readonly PageSize[];
  actions?: ReactNode;
  /** Draws one page at this scale. Called only for pages near the visible part. */
  children: (index: number, scale: number) => ReactNode;
}) {
  const [scroller, room] = useRoom();
  const [zoom, setZoom] = useState<Zoom>({ kind: 'fit' });
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set([0]));
  const widest = sizes.reduce((most, size) => Math.max(most, size.width), 1);
  const scale = scaleOf(zoom, Math.min(widestFit, fittedScale(room.width, widest)));

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) =>
        setNear((old) => {
          const next = new Set(old);
          for (const entry of entries) {
            const index = Number((entry.target as HTMLElement).dataset.page);
            if (entry.isIntersecting) next.add(index);
            else next.delete(index);
          }
          return next;
        }),
      // One screen above and below is drawn ahead, so scrolling does not show blank pages.
      { root: node, rootMargin: '100% 0px' },
    );
    node.querySelectorAll('[data-page]').forEach((page) => observer.observe(page));
    return () => observer.disconnect();
  }, [scroller, sizes.length]);

  // Zooming keeps the same part of the document in view.
  const place = useRef(0);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = place.current * node.scrollHeight;
  }, [scroller, scale]);

  return (
    <>
      <FileTabBar path={path}>
        <span className="preview-count">{sizes.length}쪽</span>
        <ZoomControls zoom={zoom} scale={scale} change={setZoom} />
        {actions}
      </FileTabBar>
      <div
        ref={scroller}
        className="preview-pages"
        onScroll={(event) => {
          const node = event.currentTarget;
          place.current = node.scrollHeight ? node.scrollTop / node.scrollHeight : 0;
        }}
      >
        {sizes.map((size, index) => (
          <div
            key={index}
            className="preview-page"
            data-page={index}
            role="img"
            aria-label={`${index + 1}쪽`}
            style={{ width: size.width * scale, height: size.height * scale }}
          >
            {near.has(index) && children(index, scale)}
          </div>
        ))}
      </div>
    </>
  );
}
