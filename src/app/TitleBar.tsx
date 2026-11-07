import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import { desktop, errorText } from '../lib/ipc';
import { isMac } from '../lib/platform';
import face from '../assets/brand/dachshund-face.png';
import './titleBar.css';

/**
 * Windows has no system title bar here, so the app draws minimize, maximize and close. Close goes
 * through close(), which raises the same close request as the system button and its guards.
 */
function WindowButtons({ fail }: { fail: (message: string) => void }) {
  const [maximized, setMaximized] = useState(false);
  const report = useEffectEvent(fail);
  useEffect(() => {
    const window = getCurrentWindow();
    let disposed = false;
    let stop: (() => void) | undefined;
    const sync = () =>
      void window
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(() => {
          // The icon only shows the state; a failed query leaves the last one.
        });
    sync();
    window
      .onResized(sync)
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch((e) => report(errorText(e)));
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  const run = (action: () => Promise<void>) => () => void action().catch((e) => fail(errorText(e)));
  return (
    <div className="window-buttons">
      <button aria-label="최소화" title="최소화" onClick={run(() => getCurrentWindow().minimize())}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" stroke="currentColor" />
        </svg>
      </button>
      <button
        aria-label={maximized ? '이전 크기로' : '최대화'}
        title={maximized ? '이전 크기로' : '최대화'}
        onClick={run(() => getCurrentWindow().toggleMaximize())}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none">
          {maximized ? (
            <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" stroke="currentColor" />
          ) : (
            <path d="M.5.5h9v9h-9z" stroke="currentColor" />
          )}
        </svg>
      </button>
      <button
        className="window-close"
        aria-label="닫기"
        title="닫기"
        onClick={run(() => getCurrentWindow().close())}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}

/**
 * The one line at the top: the OS title bar and the app header together. Empty space moves the
 * window and a double-click maximizes it. On macOS the system's own buttons sit at the left.
 */
export function TitleBar({
  title = 'DachsTerm',
  children,
  end,
  fail,
}: {
  title?: string;
  /** Menus after the app name. */
  children?: ReactNode;
  /** Controls before the window buttons. */
  end?: ReactNode;
  fail: (message: string) => void;
}) {
  return (
    <header className={`toolbar ${isMac ? 'mac' : ''}`} data-tauri-drag-region>
      {isMac && desktop && <div className="traffic-space" data-tauri-drag-region />}
      <span className="title-brand" data-tauri-drag-region="deep">
        <img src={face} alt="" width="18" height="18" />
        <strong>{title}</strong>
      </span>
      <div className="tools">{children}</div>
      <div className="title-drag" data-tauri-drag-region />
      {end && <div className="tools">{end}</div>}
      {desktop && !isMac && <WindowButtons fail={fail} />}
    </header>
  );
}
