import type { ThemeDefinition } from '../contract';
function flatten(value: object, prefix = ''): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const path = `${prefix}-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      return typeof child === 'object'
        ? Object.entries(flatten(child, path))
        : [[`-${path}`, String(child)]];
    }),
  );
}
export function cssVariables(theme: ThemeDefinition) {
  return flatten({
    ...theme.foundations,
    color: theme.color,
    terminal: theme.terminal,
    chart: theme.chart,
  });
}
export function applyTheme(theme: ThemeDefinition, root: HTMLElement = document.documentElement) {
  for (const [key, value] of Object.entries(cssVariables(theme)))
    root.style.setProperty(key, value);
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.colorScheme;
}
