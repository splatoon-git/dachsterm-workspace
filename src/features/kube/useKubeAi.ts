import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import { applyAiRead, emptyAiData, type AiData } from './aiModel';
import type { AiRead } from './aiTypes';
import type { KubePod } from './snapshotTypes';

/** The original tool's collection interval, and how fast its monitor screen samples. */
const PERIOD = 10_000;
const FAST_PERIOD = 5_000;
const SLOW_FACTOR = 3;

export type KubeAiData = AiData & { error: string; setFast: (on: boolean) => void };

const aiDelay = (fast: boolean, elapsedMs: number) =>
  Math.max(fast ? FAST_PERIOD : PERIOD, elapsedMs * SLOW_FACTOR);

/** Reads while the workspace is on screen. The next read waits for the last one (rules §7). */
export function useKubeAi(
  id: string,
  kube: KubeSettings | null,
  polling: boolean,
  pods: KubePod[] | null,
): KubeAiData {
  const [data, setData] = useState<AiData>(emptyAiData);
  const [error, setError] = useState('');
  const fast = useRef(false);
  const latestPods = useRef(pods);
  useLayoutEffect(() => {
    latestPods.current = pods;
  }, [pods]);

  useEffect(() => {
    if (!polling || !kube) return;
    let stopped = false;
    let timer: number | undefined;
    const read = async () => {
      let elapsedMs = 0;
      try {
        const answer = await call<AiRead | null>('kube_ai', { id, kube });
        if (stopped) return;
        setError('');
        if (answer) {
          elapsedMs = answer.elapsedMs;
          const at = Date.now();
          setData((now) => applyAiRead(now, answer, latestPods.current ?? [], at));
        }
      } catch (failure) {
        if (stopped) return;
        setError(errorText(failure));
      }
      timer = window.setTimeout(() => void read(), aiDelay(fast.current, elapsedMs));
    };
    void read();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [id, kube, polling]);

  const setFast = useCallback((on: boolean) => {
    fast.current = on;
  }, []);
  return useMemo(() => ({ ...data, error, setFast }), [data, error, setFast]);
}
