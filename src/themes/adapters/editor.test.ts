import { describe, expect, it } from 'vitest';
import { themes } from '../registry';
import { editorTheme } from './editor';

describe('editorTheme', () => {
  it.each(themes.map((theme) => [theme.id, theme] as const))(
    'gives %s only colors the editor accepts',
    (_id, theme) => {
      const data = editorTheme(theme);
      for (const color of Object.values(data.colors))
        expect(color).toMatch(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i);
      for (const rule of data.rules) expect(rule.foreground).toMatch(/^[0-9a-f]{6}$/i);
    },
  );

  it.each(themes.map((theme) => [theme.id, theme] as const))(
    'follows the tokens of %s',
    (_id, theme) => {
      const data = editorTheme(theme);
      expect(data.base).toBe(theme.colorScheme === 'dark' ? 'vs-dark' : 'vs');
      expect(data.colors['editor.background'].toLowerCase()).toBe(
        theme.terminal.background.toLowerCase(),
      );
      expect(data.colors['diffEditor.insertedTextBackground'].slice(0, 7).toLowerCase()).toBe(
        theme.color.status.success.toLowerCase(),
      );
    },
  );

  it('rejects a color format the editor cannot read', () => {
    const broken = {
      ...themes[0],
      terminal: { ...themes[0].terminal, background: 'rgb(0, 0, 0)' },
    };
    expect(() => editorTheme(broken)).toThrow('hex');
  });
});
