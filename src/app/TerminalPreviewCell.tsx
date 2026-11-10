import { lazy, Suspense, type ComponentProps } from 'react';
import { PlainTab } from './GroupTabBar';

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

/** Its tab: nothing to connect or save, so closing only takes it away. */
export function PreviewTab({
  tabKey,
  active,
  select,
  close,
}: {
  tabKey: string;
  active: boolean;
  select: () => void;
  close: (key: string) => void;
}) {
  return (
    <PlainTab
      tabKey={tabKey}
      title="터미널 미리보기"
      active={active}
      select={select}
      close={() => close(tabKey)}
    />
  );
}
