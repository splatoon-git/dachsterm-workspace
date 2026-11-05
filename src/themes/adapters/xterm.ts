import type { ITheme } from '@xterm/xterm';
import type { ThemeDefinition } from '../contract';
export function terminalTheme(theme: ThemeDefinition): ITheme {
  return { ...theme.terminal };
}
