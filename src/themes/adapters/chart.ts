import type { ThemeDefinition } from '../contract';
export function chartTheme(theme: ThemeDefinition) {
  return { ...theme.chart, series: [...theme.chart.series] };
}
