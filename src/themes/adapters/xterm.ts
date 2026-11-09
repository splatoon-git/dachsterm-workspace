import type { ITerminalOptions, ITheme } from '@xterm/xterm';
import type { ThemeDefinition } from '../contract';
export function terminalTheme(theme: ThemeDefinition): ITheme {
  return { ...theme.terminal };
}

/**
 * Programs choose text and background independently, and a theme can only keep each ANSI color
 * readable on the terminal background. A shell prompt that puts the default text on ANSI black is
 * dark on black in a light theme, so xterm adjusts the text where a pair falls short.
 */
export function terminalColorOptions(theme: ThemeDefinition): ITerminalOptions {
  return { theme: terminalTheme(theme), minimumContrastRatio: 4.5 };
}
