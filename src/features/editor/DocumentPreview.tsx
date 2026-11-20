import { Component, lazy, Suspense, useEffect, useMemo, type ReactNode } from 'react';
import { bytesOf, type DocumentFormat } from './documentFormats';
import { unpackRefusal } from './preview/zipEntries';
import type { ViewerProps } from './preview/viewer';

// Each viewer brings a library of its own, so it is fetched when a file of its kind first opens.
const viewers: Record<
  DocumentFormat,
  ReturnType<typeof lazy<(props: ViewerProps) => ReactNode>>
> = {
  pdf: lazy(() => import('./preview/PdfView')),
  docx: lazy(() => import('./preview/DocxView')),
  xlsx: lazy(() => import('./preview/SheetView')),
  pptx: lazy(() => import('./preview/SlidesView')),
  hwp: lazy(() => import('./preview/HwpView')),
  hwpx: lazy(() => import('./preview/HwpView')),
};
/** Formats that are ZIP packages, checked before anything unpacks them. */
const packaged: ReadonlySet<DocumentFormat> = new Set(['docx', 'xlsx', 'pptx', 'hwpx']);
const UNDRAWN = '미리보기를 표시하지 못했습니다.';

/** A viewer that throws, or whose code could not be loaded, becomes a notice instead of a blank tab. */
class ViewerBoundary extends Component<
  { fail: (message: string) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.fail(UNDRAWN);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type Prepared = { bytes: Uint8Array; refusal: null } | { bytes: null; refusal: string };

function prepare(format: DocumentFormat, data: string): Prepared {
  let bytes: Uint8Array;
  try {
    bytes = bytesOf(data);
  } catch {
    // Not base64, which the backend never sends. Shown as a file that cannot be drawn.
    return { bytes: null, refusal: UNDRAWN };
  }
  const refusal = packaged.has(format) ? unpackRefusal(bytes) : null;
  return refusal ? { bytes: null, refusal } : { bytes, refusal: null };
}

/** A document drawn in the tab, read-only. `fail` replaces it with a notice. */
export function DocumentPreview({
  format,
  data,
  ...viewer
}: Omit<ViewerProps, 'bytes'> & { format: DocumentFormat; data: string }) {
  const { fail } = viewer;
  const prepared = useMemo(() => prepare(format, data), [format, data]);
  useEffect(() => {
    if (prepared.refusal) fail(prepared.refusal);
  }, [prepared, fail]);
  if (!prepared.bytes) return null;
  const Viewer = viewers[format];
  return (
    <ViewerBoundary fail={fail}>
      <Suspense
        fallback={
          <div className="editor-loading" role="status">
            미리보기를 준비하는 중…
          </div>
        }
      >
        <Viewer {...viewer} bytes={prepared.bytes} />
      </Suspense>
    </ViewerBoundary>
  );
}
