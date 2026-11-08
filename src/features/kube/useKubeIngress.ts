import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import {
  applyIngress,
  emptyIngress,
  failedIngress,
  INGRESS_POLL_MS,
  type IngressData,
} from './ingressModel';
import type { IngressReport } from './ingressTypes';
import { backoffDelay } from './polling';

const subscribeVisibility = (change: () => void) => {
  document.addEventListener('visibilitychange', change);
  return () => document.removeEventListener('visibilitychange', change);
};
const documentVisible = () => document.visibilityState !== 'hidden';

/**
 * Polls while `shown`. Rates compare two polls by their own timestamps, so a gap while another
 * screen was open only makes the interval longer. One request at a time: one that outlives a hide
 * is kept, and the next poll waits for it.
 */
export function useKubeIngress(id: string, settings: KubeSettings | null, shown: boolean) {
  const [data, setData] = useState<IngressData>(emptyIngress);
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible);
  const inFlight = useRef(false);
  const nextAt = useRef(0);
  const pump = useRef<(() => void) | null>(null);
  const polling = shown && visible && settings !== null;

  useEffect(() => {
    if (!polling || !settings) return;
    let timer: number | undefined;
    const run = () => {
      window.clearTimeout(timer);
      if (inFlight.current) return;
      const wait = nextAt.current - Date.now();
      if (wait > 0) {
        timer = window.setTimeout(run, wait);
        return;
      }
      inFlight.current = true;
      void call<IngressReport>('kube_ingress', { id, kube: settings })
        .catch((error: unknown) => failedIngress(errorText(error)))
        .then((report) => {
          inFlight.current = false;
          nextAt.current =
            Date.now() + backoffDelay(INGRESS_POLL_MS, report.elapsedMs, report.state);
          setData((now) => applyIngress(now, report));
          pump.current?.();
        });
    };
    pump.current = run;
    run();
    return () => {
      pump.current = null;
      window.clearTimeout(timer);
    };
  }, [id, polling, settings]);

  return data;
}
