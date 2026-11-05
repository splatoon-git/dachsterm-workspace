import { describe, it, expect } from 'vitest';
import { defaultTheme, getTheme, themes } from './registry';
import { cssVariables } from './adapters/css';
import { terminalTheme } from './adapters/xterm';
import { chartTheme } from './adapters/chart';
import type { ThemeDefinition } from './contract';
function contrast(a: string, b: string) {
  const luminance = (hex: string) =>
    hex
      .match(/[a-f\d]{2}/gi)!
      .map((x) => parseInt(x, 16) / 255)
      .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
      .reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0);
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
describe('theme contract', () => {
  it('preserves the classic default and safely falls back for unknown persisted IDs', () => {
    expect(defaultTheme.id).toBe('pms-retro-light');
    expect(new Set(themes.map((theme) => theme.id)).size).toBe(themes.length);
    expect(themes).toHaveLength(12);
    expect(getTheme('removed')).toBe(defaultTheme);
    expect(getTheme(null)).toBe(defaultTheme);
    for (const theme of themes) {
      expect(getTheme(theme.id)).toBe(theme);
      expect(Object.keys(cssVariables(theme)).sort()).toEqual(
        Object.keys(cssVariables(defaultTheme)).sort(),
      );
      expect(terminalTheme(theme)).toEqual(theme.terminal);
    }
  });
  it('derives every renderer from an unregistered replacement definition', () => {
    const alternative: ThemeDefinition = structuredClone(defaultTheme);
    alternative.id = 'test-only';
    alternative.color.surface.panel = '#123456';
    alternative.terminal.background = '#234567';
    alternative.chart.series = ['#345678', '#456789', '#567890', '#678901'];
    expect(cssVariables(alternative)['--color-surface-panel']).toBe('#123456');
    expect(terminalTheme(alternative).background).toBe('#234567');
    expect(chartTheme(alternative).series[0]).toBe('#345678');
    expect(themes.some((theme) => theme.id === alternative.id)).toBe(false);
  });
  it.each(themes)('$name meets text, focus and meaningful input-boundary contrast', (theme) => {
    const { color, terminal } = theme;
    for (const surface of Object.values(color.surface)) {
      for (const foreground of [
        color.text.primary,
        color.text.secondary,
        ...Object.values(color.status),
      ])
        expect(contrast(foreground, surface), `${foreground} on ${surface}`).toBeGreaterThanOrEqual(
          4.5,
        );
      expect(contrast(color.focus.ring, surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(color.border.input, surface)).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(color.text.onAction, color.action.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color.action.onAccent, color.action.accent)).toBeGreaterThanOrEqual(4.5);
    for (const background of [color.action.hover, color.action.active, color.action.selected]) {
      expect(
        contrast(color.text.primary, background),
        `primary on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(color.text.secondary, color.action.selected)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(terminal.foreground, terminal.background)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(terminal.selectionForeground, terminal.selectionBackground),
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrast(terminal.cursor, terminal.background)).toBeGreaterThanOrEqual(3);
    expect(contrast(terminal.cursorAccent, terminal.cursor)).toBeGreaterThanOrEqual(3);
    // htop uses ANSI black text on these colored header/selection backgrounds.
    for (const background of [terminal.green, terminal.blue, terminal.cyan])
      expect(
        contrast(terminal.black, background),
        `ANSI black on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    for (const key of [
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'brightBlack',
      'brightRed',
      'brightGreen',
      'brightYellow',
      'brightBlue',
      'brightMagenta',
      'brightCyan',
      'brightWhite',
    ] as const) {
      // ANSI black must stay dark for black-on-color TUI headers in dark themes.
      if (key === 'black' && theme.colorScheme === 'dark') continue;
      expect(
        contrast(terminal[key], terminal.background),
        `${key} on terminal background`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
