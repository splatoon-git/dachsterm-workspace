import { lazy, Suspense, type ComponentProps } from 'react';

const TerminalPreview = lazy(() =>
  import('../features/terminal/TerminalPreview').then((m) => ({ default: m.TerminalPreview })),
);

/** The terminal colour preview tab: no connection behind it. */
export function TerminalPreviewCell({ theme }: ComponentProps<typeof TerminalPreview>) {
  return (
    <div className="preview-wrap">
      <div className="preview-notice">색상과 한글 렌더링 미리보기 · SSH 연결 없음</div>
      <Suspense fallback={<p>터미널 준비 중…</p>}>
        <TerminalPreview theme={theme} />
      </Suspense>
    </div>
  );
}
