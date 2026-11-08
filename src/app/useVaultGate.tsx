import { useState } from 'react';
import { VaultDialog, type VaultStatus } from '../features/sessions/VaultDialog';
import { call, errorText } from '../lib/ipc';

/** Holds back anything that needs a saved secret until the vault is unlocked. */
export function useVaultGate(fail: (message: string) => void) {
  const [open, setOpen] = useState(false);
  /** What runs once the vault unlocks. */
  const [pending, setPending] = useState<(() => void) | null>(null);
  /** False when the vault has to unlock first; `retry` then runs once it has. */
  const ready = async (retry: () => void) => {
    try {
      const status = await call<VaultStatus>('vault_status');
      if (!status.enabled || status.unlocked) return true;
      setPending(() => retry);
      setOpen(true);
    } catch (e) {
      fail(errorText(e));
    }
    return false;
  };
  const dialog = open && (
    <VaultDialog
      close={() => {
        setOpen(false);
        setPending(null);
      }}
      unlocked={pending ?? undefined}
    />
  );
  return { ready, dialog };
}
