import type { ThemeDefinition } from '../contract';

/** Matches Monaco's theme data. Declared here so the theme layer does not import the component. */
export type EditorThemeData = {
  base: 'vs' | 'vs-dark';
  inherit: boolean;
  rules: { token: string; foreground: string }[];
  colors: Record<string, string>;
};

/** Monaco reads only `#rrggbb` and `#rrggbbaa`. Theme tests run every preset through this. */
function hex(color: string) {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color)) return color;
  throw new Error(`The editor theme needs hex colors: ${color}`);
}

function withAlpha(color: string, alpha: number) {
  const byte = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex(color).slice(0, 7)}${byte}`;
}

export function editorTheme(theme: ThemeDefinition): EditorThemeData {
  const { terminal, color } = theme;
  const token = (name: string, value: string) => ({
    token: name,
    foreground: hex(value).slice(1, 7),
  });
  return {
    base: theme.colorScheme === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      token('', terminal.foreground),
      token('comment', terminal.brightBlack),
      token('string', terminal.green),
      token('keyword', terminal.magenta),
      token('number', terminal.yellow),
      token('type', terminal.cyan),
      token('regexp', terminal.red),
    ],
    colors: Object.fromEntries(
      Object.entries({
        'editor.background': terminal.background,
        'editor.foreground': terminal.foreground,
        'editorCursor.foreground': terminal.cursor,
        'editor.selectionBackground': terminal.selectionBackground,
        'editor.inactiveSelectionBackground': withAlpha(terminal.selectionBackground, 0.5),
        'editor.lineHighlightBackground': withAlpha(terminal.foreground, 0.06),
        'editorLineNumber.foreground': withAlpha(terminal.foreground, 0.45),
        'editorLineNumber.activeForeground': terminal.foreground,
        'editorGutter.background': terminal.background,
        'minimap.background': terminal.background,
        'editorWidget.background': color.surface.panel,
        'editorWidget.foreground': color.text.primary,
        'editorWidget.border': color.border.default,
        'input.background': color.surface.subtle,
        'input.foreground': color.text.primary,
        'input.border': color.border.input,
        focusBorder: color.focus.ring,
        'list.activeSelectionBackground': color.action.selected,
        'list.hoverBackground': color.action.hover,
        'diffEditor.insertedLineBackground': withAlpha(color.status.success, 0.14),
        'diffEditor.insertedTextBackground': withAlpha(color.status.success, 0.3),
        'diffEditor.removedLineBackground': withAlpha(color.status.error, 0.14),
        'diffEditor.removedTextBackground': withAlpha(color.status.error, 0.3),
      }).map(([name, value]) => [name, hex(value)]),
    ),
  };
}
