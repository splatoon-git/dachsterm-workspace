import type { ThemeDefinition } from '../contract';
import { foundations } from '../foundations';

type Palette = Pick<ThemeDefinition, 'id' | 'name' | 'description' | 'category' | 'colorScheme'> & {
  // app, panel, subtle, header; text, secondary; border, input
  surfaces: readonly [string, string, string, string];
  text: readonly [string, string];
  borders: readonly [string, string];
  primary: string;
  onAction: string;
  accent: string;
  onAccent: string;
  // hover, active, selected
  interaction: readonly [string, string, string];
  // success, info, warning, error
  status: readonly [string, string, string, string];
  // ANSI order: black, red, green, yellow, blue, magenta, cyan, white, then bright variants.
  ansi: readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  monoUI?: boolean;
  terminalBackground?: string;
};

/** Only theme definitions contain palette values; every renderer shares this contract. */
export function createTheme(p: Palette): ThemeDefinition {
  const [app, panel, subtle, header] = p.surfaces;
  const [primary, secondary] = p.text;
  const [success, info, warning, error] = p.status;
  const [
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  ] = p.ansi;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    category: p.category,
    colorScheme: p.colorScheme,
    foundations: p.monoUI
      ? {
          ...foundations,
          font: { ...foundations.font, ui: foundations.font.mono },
          radius: { xs: '2px', small: '3px', medium: '6px', large: '8px', full: '999px' },
        }
      : foundations,
    color: {
      surface: { app, panel, subtle, header },
      text: { primary, secondary, onAction: p.onAction, disabled: secondary },
      border: { default: p.borders[0], subtle: p.borders[0], input: p.borders[1] },
      action: {
        primary: p.primary,
        default: panel,
        hover: p.interaction[0],
        active: p.interaction[1],
        selected: p.interaction[2],
        disabled: subtle,
        focus: p.primary,
        accent: p.accent,
        onAccent: p.onAccent,
      },
      status: { success, info, warning, error },
      focus: { ring: p.primary },
      overlay: { backdrop: p.colorScheme === 'dark' ? '#00000080' : '#18203030' },
    },
    terminal: {
      background: p.terminalBackground ?? panel,
      foreground: primary,
      cursor: p.primary,
      cursorAccent: p.onAction,
      selectionBackground: p.interaction[2],
      selectionForeground: primary,
      black,
      red,
      green,
      yellow,
      blue,
      magenta,
      cyan,
      white,
      brightBlack,
      brightRed,
      brightGreen,
      brightYellow,
      brightBlue,
      brightMagenta,
      brightCyan,
      brightWhite,
    },
    chart: {
      series: [p.primary, success, magenta, warning],
      axis: secondary,
      grid: p.borders[0],
      tooltip: panel,
      tooltipText: primary,
    },
  };
}
