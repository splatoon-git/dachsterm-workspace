import { useEffect, useMemo, useState } from 'react';
import init, { HwpDocument } from '@rhwp/core';
import engineUrl from '@rhwp/core/rhwp_bg.wasm?url';
import { PagedPreview, type PageSize } from './Pages';
import type { ViewerProps } from './viewer';

type Measured = typeof globalThis & { measureTextWidth?: (font: string, text: string) => number };

/** The layout engine asks the page how wide a piece of text is in a font. */
function installMeasure() {
  let context: CanvasRenderingContext2D | null = null;
  let last = '';
  (globalThis as Measured).measureTextWidth = (font, text) => {
    context ??= document.createElement('canvas').getContext('2d');
    if (!context) return 0;
    if (font !== last) {
      context.font = font;
      last = font;
    }
    return context.measureText(text).width;
  };
}

let ready: Promise<unknown> | null = null;
/** Loads the engine once, when the first 한글 file opens. A failed load is tried again next time. */
function engine() {
  ready ??= Promise.resolve()
    .then(() => {
      installMeasure();
      return init({ module_or_path: engineUrl });
    })
    .catch((error: unknown) => {
      ready = null;
      throw error;
    });
  return ready;
}

function pageSizes(file: HwpDocument): PageSize[] {
  return Array.from({ length: file.pageCount() }, (_, index) => {
    const { width, height } = JSON.parse(file.getPageInfo(index)) as Partial<PageSize>;
    if (!(Number(width) > 0) || !(Number(height) > 0)) throw new Error('page size');
    return { width: Number(width), height: Number(height) };
  });
}

function Page({ file, index }: { file: HwpDocument; index: number }) {
  // Only ever an <img>: nothing inside the drawing can run or fetch this way.
  const source = useMemo(() => {
    try {
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.renderPageSvg(index))}`;
    } catch {
      // This page stays blank beside the ones that could be drawn.
      return null;
    }
  }, [file, index]);
  return source && <img src={source} alt="" />;
}

/** A 한글 document (hwp, hwpx), laid out page by page. */
export default function HwpView({ bytes, path, actions, fail }: ViewerProps) {
  const [opened, setOpened] = useState<{ file: HwpDocument; sizes: PageSize[] } | null>(null);
  useEffect(() => {
    let alive = true;
    let file: HwpDocument | null = null;
    engine().then(
      () => {
        if (!alive) return;
        try {
          file = new HwpDocument(bytes);
          const sizes = pageSizes(file);
          if (!sizes.length) throw new Error('no pages');
          setOpened({ file, sizes });
        } catch {
          fail('한글 문서를 읽지 못했습니다. 암호가 걸렸거나 지원하지 않는 형식일 수 있습니다.');
        }
      },
      () => {
        if (alive) fail('한글 문서 보기를 준비하지 못했습니다.');
      },
    );
    return () => {
      alive = false;
      // Pages still on screen draw nothing from a freed document until the next one is set.
      file?.free();
    };
  }, [bytes, fail]);
  if (!opened)
    return (
      <div className="editor-loading" role="status">
        한글 문서를 여는 중…
      </div>
    );
  return (
    <PagedPreview path={path} sizes={opened.sizes} actions={actions}>
      {(index) => <Page file={opened.file} index={index} />}
    </PagedPreview>
  );
}
