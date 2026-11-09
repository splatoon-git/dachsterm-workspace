import { useCallback, useEffect, useState } from 'react';
import { call } from '../../lib/ipc';
import type { OperateMode } from './actionModel';

export type OperateControl = {
  mode: OperateMode;
  /** Asks the backend again. A write it refused may mean another tab changed the mode. */
  reload: () => void;
  /** Rejects with the backend's message; the mode stays as it was. */
  change: (on: boolean) => Promise<void>;
};

/** The screen's picture of the stored mode. `kube_action` reads the store itself. */
export function useOperateMode(connectionId: string, open: boolean): OperateControl {
  const [mode, setMode] = useState<OperateMode>('checking');

  const reload = useCallback(() => {
    call<OperateMode>('kube_operate_mode', { id: connectionId }).then(setMode, () =>
      setMode('failed'),
    );
  }, [connectionId]);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  const change = useCallback(
    async (on: boolean) => {
      setMode(await call<OperateMode>('kube_set_operate_mode', { id: connectionId, on }));
    },
    [connectionId],
  );

  return { mode, reload, change };
}
