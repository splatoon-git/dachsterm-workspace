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
  /var\(\s*(--(?:space|font|radius|border-width|shadow|motion|color|terminal|chart)-[a-z0-9-]*[a-z0-9])\s*[,)]/g;

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
});
