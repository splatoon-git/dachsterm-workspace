import { kubeScreens, type KubeScreen } from './kubeModel';

const storageKey = (session: string) => `dachsterm.kube.screen.${session}`;

/** The tree is the first screen; a session that left another one comes back to it. */
export function readLastScreen(session: string): KubeScreen {
  if (!session) return 'tree';
  try {
    const saved = localStorage.getItem(storageKey(session));
    return kubeScreens.find((item) => item.id === saved)?.id ?? 'tree';
  } catch {
    return 'tree';
  }
}

export function writeLastScreen(session: string, screen: KubeScreen) {
  if (!session) return;
  try {
    localStorage.setItem(storageKey(session), screen);
  } catch {
    // Reopening on the first screen is harmless; a full or blocked store must not stop the switch.
  }
}
