import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { renderAsync } from 'docx-preview';
import { FileTabBar } from '../TextDocument';
import { useRoom, ZoomControls } from './Pages';
import { fittedScale, scaleOf, type Zoom } from './zoom';
import type { ViewerProps } from './viewer';
import './preview.css';

/** A4 at 100%, until the document's own page width is known. */
const defaultWidth = 794;
/** The gap the library's wrapper keeps around its pages, on each side. */
const wrapperGap = 30;

/** The page width the library set on a section, such as `595.3pt`, in CSS pixels. */
function sectionWidth(value: string) {
  const size = parseFloat(value);
  if (!(size > 0)) return defaultWidth;
  if (value.endsWith('pt')) return (size * 96) / 72;
  return value.endsWith('px') ? size : defaultWidth;
}

/** A Word document laid out by its own styles. Embedded fonts and HTML parts are not loaded. */
export default function DocxView({ bytes, path, actions, fail }: ViewerProps) {
  const [host, room] = useRoom();
  const body = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [zoom, setZoom] = useState<Zoom>({ kind: 'fit' });
  useEffect(() => {
    const target = body.current;
    if (!target) return;
    let alive = true;
    renderAsync(bytes, target, undefined, {
      className: 'docx',
      inWrapper: true,
      useBase64URL: true,
      // Fonts inside the file would be loaded from data URLs, which the app's policy refuses.
      ignoreFonts: true,
      // An embedded HTML part is drawn in a frame of its own. A preview shows the document only.
      renderAltChunks: false,
    }).then(
      () => {
        if (!alive) return;
        const section = target.querySelector<HTMLElement>('section.docx');
        setWidth(sectionWidth(section?.style.width ?? ''));
      },
      () => {
        if (alive) fail('문서를 읽지 못했습니다. 암호가 걸렸거나 손상된 파일일 수 있습니다.');
      },
    );
    return () => {
      alive = false;
      target.replaceChildren();
    };
  }, [bytes, fail]);
  const fitted = fittedScale(room.width, (width ?? defaultWidth) + wrapperGap * 2);
  const scale = scaleOf(zoom, Math.min(1.5, fitted));
  return (
    <>
      <FileTabBar path={path}>
        <ZoomControls zoom={zoom} scale={scale} change={setZoom} />
        {actions}
      </FileTabBar>
      {width === null && (
        <div className="editor-loading" role="status">
          문서를 여는 중…
        </div>
      )}
      <div ref={host} className="preview-flow preview-docx" hidden={width === null}>
        {/* A link in the document must not take the window away from the app. */}
        <div
          ref={body}
          style={{ zoom: scale } as CSSProperties}
          onClick={(event) => {
            if ((event.target as Element).closest('a')) event.preventDefault();
          }}
        />
      </div>
    </>
  );
}
