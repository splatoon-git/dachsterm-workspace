import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Profile } from '../../lib/ipc';
import { SourceLink, sourceOf, type SourceMode } from './sourceLink';

/** False when the vault has to unlock first; `retry` then runs once it has. */
export type VaultReady = (retry: () => void) => Promise<boolean>;

/** A tool tab's source. Closing the tab, or going back to local, lets go of the remote link. */
export function useSource(vaultReady: VaultReady) {
  const [link] = useState(() => new SourceLink());
  const state = useSyncExternalStore(link.subscribe, link.snapshot);
  const [mode, setMode] = useState<SourceMode>('local');
  useEffect(() => () => link.release(), [link]);
  async function pick(profile: Profile) {
    if (profile.hasSecret && !(await vaultReady(() => void pick(profile)))) return;
    await link.open(profile);
  }
  return {
    mode,
    link: state,
    source: sourceOf(mode, state),
    chooseLocal: () => {
      setMode('local');
      link.release();
    },
    chooseRemote: () => setMode('remote'),
    pick: (profile: Profile) => void pick(profile),
    retry: () => {
      if (state.profile) void pick(state.profile);
    },
    trust: (accept: boolean) => void link.trust(accept),
    reply: (responses: string[]) => link.reply(responses),
    cancel: () => link.release(),
  };
}
export type SourceControl = ReturnType<typeof useSource>;
