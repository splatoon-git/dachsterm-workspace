import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { desktop, errorText } from '../lib/ipc';

export function useFullscreen(onError: (message: string) => void) {
  const [fullscreen, setFullscreen] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    const sync = () =>
      void getCurrentWindow()
        .isFullscreen()
        .then((value) => {
          if (alive) setFullscreen(value);
        })
        .catch((e) => {
          if (alive) onError(errorText(e));
        });
    sync();
    void getCurrentWindow()
      .onResized(sync)
      .then((off) => {
        if (alive) unlisten = off;
        else off();
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [onError]);
  const toggleFullscreen = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      const next = !fullscreen;
      if (desktop) await getCurrentWindow().setFullscreen(next);
      setFullscreen(next);
    } catch (e) {
      onError(errorText(e));
    } finally {
      pending.current = false;
    }
  }, [fullscreen, onError]);
  return { fullscreen, toggleFullscreen };
}
