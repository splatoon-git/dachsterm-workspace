import { useLayoutEffect, useSyncExternalStore } from 'react';
import { applyTheme } from './adapters/css';
import { getCurrentTheme, subscribeTheme } from './store';
export function useTheme() {
  const theme = useSyncExternalStore(subscribeTheme, getCurrentTheme);
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);
  return theme;
}
