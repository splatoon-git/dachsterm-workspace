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

/**
 * The theme's fonts have no Powerline arrows (U+E0B0), so WebKit leaves those cells blank. These
 * come after the theme's fonts so that only the glyphs those fonts lack are drawn from them.
 */
const powerlineFonts =
  "'MesloLGS NF', 'MesloLGS Nerd Font Mono', 'JetBrainsMono Nerd Font Mono', 'CaskaydiaCove Nerd Font Mono', 'Cascadia Code PL'";

export function terminalFontFamily(theme: ThemeDefinition): string {
  return `${theme.foundations.font.mono}, ${powerlineFonts}`;
}
