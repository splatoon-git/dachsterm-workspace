import { useEffect, useRef, useState } from 'react';
// The legacy build runs on the older web views the app still starts on (W.1).
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?worker';
import { PagedPreview, type PageSize } from './Pages';
import type { ViewerProps } from './viewer';

type Document = pdfjs.PDFDocumentProxy;

/** PDF units are 1/72 inch and CSS pixels 1/96, so this draws a page at its real size. */
const cssPixels = 96 / 72;
/** The most pixels one page's canvas holds. Past it the page is drawn less sharply, not refused. */
const canvasPixels = 16_000_000;
/** Data files the library fetches by name while it reads a document (`vite.config.ts`). */
const assets = (folder: string) => new URL(`pdfjs/${folder}/`, document.baseURI).href;

let worker: pdfjs.PDFWorker | null = null;
/** One worker for every PDF tab. It lives as long as the window. */
const sharedWorker = () => (worker ??= new pdfjs.PDFWorker({ port: new PdfWorker() as never }));

const sizeOf = (page: pdfjs.PDFPageProxy): PageSize => {
  const { width, height } = page.getViewport({ scale: cssPixels });
  return { width, height };
};

function Page({
  file,
  index,
  scale,
  sized,
}: {
  file: Document;
  index: number;
  scale: number;
  sized: (index: number, size: PageSize) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    let task: pdfjs.RenderTask | null = null;
    void file.getPage(index + 1).then(
      (page) => {
        const target = canvas.current;
        if (!alive || !target) return;
        sized(index, sizeOf(page));
        const css = page.getViewport({ scale: cssPixels * scale });
        const density = Math.min(
          window.devicePixelRatio || 1,
          Math.sqrt(canvasPixels / (css.width * css.height)),
        );
        const viewport = page.getViewport({ scale: cssPixels * scale * density });
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        task = page.render({ canvas: target, viewport });
        // A cancelled draw rejects, and a page that cannot be drawn stays blank beside the others.
        task.promise.catch(() => {});
      },
      // The page stays blank; the document itself opened.
      () => {},
    );
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [file, index, scale, sized]);
  return <canvas ref={canvas} />;
}

const reasonOf = (error: unknown) =>
  (error as { name?: string })?.name === 'PasswordException'
    ? '암호가 걸린 PDF는 미리 볼 수 없습니다.'
    : 'PDF를 읽지 못했습니다. 파일이 손상됐거나 지원하지 않는 형식입니다.';

export default function PdfView({ bytes, path, actions, fail }: ViewerProps) {
  const [opened, setOpened] = useState<{ file: Document; sizes: PageSize[] } | null>(null);
  useEffect(() => {
    let alive = true;
    // The library hands the bytes to its worker, so it gets a copy of its own.
    const loading = pdfjs.getDocument({
      data: bytes.slice(),
      worker: sharedWorker(),
      cMapUrl: assets('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: assets('standard_fonts'),
      wasmUrl: assets('wasm'),
      iccUrl: assets('iccs'),
      // A preview only draws: no scripts, no forms that run code.
      enableXfa: false,
    });
    loading.promise
      .then(async (file) => {
        // Pages usually share one size. Each page corrects its own when it is drawn.
        const first = sizeOf(await file.getPage(1));
        if (alive) setOpened({ file, sizes: Array.from({ length: file.numPages }, () => first) });
      })
      .catch((error: unknown) => {
        if (alive) fail(reasonOf(error));
      });
    return () => {
      alive = false;
      void loading.destroy();
    };
  }, [bytes, fail]);
  const sized = useRef((index: number, size: PageSize) =>
    setOpened(
      (old) =>
        old && {
          ...old,
          sizes: old.sizes.map((known, at) =>
            at === index && (known.width !== size.width || known.height !== size.height)
              ? size
              : known,
          ),
        },
    ),
  ).current;
  if (!opened)
    return (
      <div className="editor-loading" role="status">
        PDF를 여는 중…
      </div>
    );
  return (
    <PagedPreview path={path} sizes={opened.sizes} actions={actions}>
      {(index, scale) => (
        // A new canvas for each scale: the library refuses two draws on one canvas.
        <Page key={scale} file={opened.file} index={index} scale={scale} sized={sized} />
      )}
    </PagedPreview>
  );
}
