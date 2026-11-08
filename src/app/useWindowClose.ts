import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useEffectEvent } from 'react';
import { desktop, errorText } from '../lib/ipc';

/**
 * What must be settled before the window goes. The native close waits for an answer; a reload can
 * only be refused or let through on the spot, which is why there are two questions.
 */
export function useWindowClose({
  confirm,
  blocked,
  fail,
}: {
  confirm: () => Promise<boolean>;
  blocked: () => boolean;
  fail: (message: string) => void;
}) {
  const ask = useEffectEvent(confirm);
  const refuses = useEffectEvent(blocked);
  const report = useEffectEvent(fail);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (!(await ask())) event.preventDefault();
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((e) => report(errorText(e)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    // Browser reload/close is best-effort; native close uses the cancellable handler above.
    const save = (event: BeforeUnloadEvent) => {
      if (refuses()) event.preventDefault();
    };
    window.addEventListener('beforeunload', save);
    return () => window.removeEventListener('beforeunload', save);
  }, []);
}
