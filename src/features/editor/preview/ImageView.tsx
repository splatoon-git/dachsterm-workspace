import { useState, type ReactNode } from 'react';
import { FileTabBar } from '../TextDocument';
import { useRoom, ZoomControls, type PageSize } from './Pages';
import { scaleOf, type Zoom } from './zoom';
import './preview.css';

/** What a picture with no size of its own, such as some SVGs, is drawn at. */
const unsized: PageSize = { width: 300, height: 150 };

/** Fitting shows the whole picture and never enlarges a small one. */
function fitted(room: PageSize, picture: PageSize) {
  if (!(room.width > 0) || !(room.height > 0)) return 1;
  return Math.min(1, room.width / picture.width, room.height / picture.height);
}

export function ImageView({
  source,
  name,
  path,
  actions,
  fail,
}: {
  /** A data URL. */
  source: string;
  name: string;
  path: string;
  actions?: ReactNode;
  fail: (message: string) => void;
}) {
  const [host, room] = useRoom();
  const [size, setSize] = useState<PageSize | null>(null);
  const [zoom, setZoom] = useState<Zoom>({ kind: 'fit' });
  const scale = scaleOf(zoom, size ? fitted(room, size) : 1);
  return (
    <>
      <FileTabBar path={path}>
        {size && (
          <span className="preview-count">
            {size.width} × {size.height}
          </span>
        )}
        <ZoomControls zoom={zoom} scale={scale} change={setZoom} />
        {actions}
      </FileTabBar>
      <div ref={host} className="preview-image">
        {/* Only ever an <img>: an SVG cannot run scripts or fetch anything this way. */}
        <img
          src={source}
          alt={name}
          style={size ? { width: size.width * scale, height: size.height * scale } : undefined}
          onLoad={({ currentTarget: image }) =>
            setSize({
              width: image.naturalWidth || unsized.width,
              height: image.naturalHeight || unsized.height,
            })
          }
          onError={() => fail('이미지를 표시하지 못했습니다. 파일이 손상됐을 수 있습니다.')}
        />
      </div>
    </>
  );
}
