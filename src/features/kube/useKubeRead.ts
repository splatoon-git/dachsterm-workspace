import { useEffect, useEffectEvent, useState } from 'react';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import type { Detail, DetailKind, PodRef } from './detailTypes';
import { stateNote } from './polling';

type Result<T> = { key: string; data: T | null; error: string };

/** One read for one `key`; a change of key starts again and an answer to an old key is dropped. */
export function useKubeRead<T>(load: () => Promise<T | null>, key: string) {
  const [result, setResult] = useState<Result<T> | null>(null);
  const read = useEffectEvent(load);
  useEffect(() => {
    let live = true;
    read().then(
      (data) => live && setResult({ key, data, error: '' }),
      (e: unknown) => live && setResult({ key, data: null, error: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  const current = result?.key === key ? result : null;
  return { data: current?.data ?? null, error: current?.error ?? '', loading: current === null };
}

export const readDetail = (
  id: string,
  kube: KubeSettings,
  pod: PodRef,
  kind: DetailKind,
): Promise<Detail> =>
  call<Detail>('kube_detail', {
    id,
    kube,
    target: { namespace: pod.namespace, pod: pod.name },
    kind,
  });

/** The sentence for a detail that did not arrive. */
export const detailNote = (detail: Detail | null, error: string) =>
  error || (detail && detail.state.kind !== 'ready' ? stateNote(detail.state) : '');
