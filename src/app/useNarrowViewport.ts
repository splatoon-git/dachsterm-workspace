import { useSyncExternalStore } from 'react';

function subscribeNarrowViewport(listener: () => void) {
  const media = window.matchMedia('(max-width: 700px)');
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

/** A window this narrow shows one group and turns the sidebar into a drawer. */
export const useNarrowViewport = () =>
  useSyncExternalStore(subscribeNarrowViewport, () => window.innerWidth <= 700);
