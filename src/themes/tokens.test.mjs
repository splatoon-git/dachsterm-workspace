// A .mjs test because this one reads the disk and the project has no Node type definitions.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cssVariables } from './adapters/css';
import { defaultTheme } from './registry';

// Read from disk: Vitest replaces stylesheets with empty modules, even with `?raw`.
const root = fileURLToPath(new URL('..', import.meta.url));
const sources = readdirSync(root, { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.(css|tsx)$/.test(file))
  .map((file) => [file, readFileSync(join(root, file), 'utf8')]);
// Only names in the theme's namespaces; layout variables like --tree-indent are set by components.
const themeToken =
  /var\(\s*(--(?:space|font|radius|border-width|shadow|motion|layer|color|terminal|chart)-[a-z0-9-]*[a-z0-9])\s*[,)]/g;

const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');

describe('theme tokens in stylesheets', () => {
  it('references only tokens the theme defines', () => {
    const defined = new Set(Object.keys(cssVariables(defaultTheme)));
    const references = sources.flatMap(([file, text]) =>
      [...text.matchAll(themeToken)].map((match) => ({ file, token: match[1] })),
    );
    expect(references.length).toBeGreaterThan(100);
    // An undefined token makes the whole declaration invalid, so the style silently disappears.
    expect(references.filter(({ token }) => !defined.has(token))).toEqual([]);
  });

  it('keeps colors in the theme definitions', () => {
    const color = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i;
    const code = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((file) => file.replaceAll('\\', '/'))
      .filter((file) => /\.(css|tsx?)$/.test(file) && !/^themes\/|\.test\./.test(file));
    const found = code.flatMap((file) =>
      withoutComments(readFileSync(join(root, file), 'utf8'))
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*)/.test(line) && color.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(found).toEqual([]);
  });

  // Sizes a theme can change. Layout geometry is not one: a component that needs an exact width
  // names it in a local custom property, which this check does not look at.
  it('takes sizes, spacing and stacking from foundation tokens', () => {
    const sized =
      /^(?:font|font-size|letter-spacing|line-height|gap|row-gap|column-gap|outline(?:-width|-offset)?|(?:padding|margin)(?:-[a-z-]+)?|border(?:-(?:top|bottom|left|right))?(?:-width)?|border(?:-(?:top|bottom)-(?:left|right))?-radius)$/;
    const literalSize = /(?<![\w.-])-?\d*\.?\d+(?:px|em|rem)\b/;
    const unitless = /^(?:z-index|font-weight|line-height)$/;
    const declaration = /([a-z-]+)\s*:\s*([^;{}]+);/g;
    const found = sources
      .filter(([file]) => file.endsWith('.css'))
      .flatMap(([file, text]) =>
        [...withoutComments(text).matchAll(declaration)].flatMap(([, property, value]) => {
          const bare = value.replace(/var\([^()]*\)/g, '').trim();
          const hardcoded =
            (sized.test(property) && literalSize.test(bare.replace(/\b0(?:px|em|rem)\b/g, ''))) ||
            (property.endsWith('radius') && /\d%/.test(bare)) ||
            (unitless.test(property) && /^(?:\d|bold\b)/.test(bare));
          return hardcoded ? [`${file}: ${property}: ${value.trim()}`] : [];
        }),
      );
    expect(found).toEqual([]);
  });
});
