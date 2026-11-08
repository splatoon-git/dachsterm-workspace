import type { Foundations } from './contract';
export const foundations: Foundations = {
  space: { xs: '4px', sm: '8px', md: '12px', lg: '16px', xl: '24px', xxl: '32px' },
  font: {
    ui: "'Segoe UI', 'Apple SD Gothic Neo', sans-serif",
    mono: "'Cascadia Code', 'SFMono-Regular', Consolas, monospace",
    small: '12px',
    body: '14px',
    title: '28px',
  },
  radius: { small: '6px', medium: '10px', large: '16px' },
  borderWidth: { default: '1px', focus: '2px' },
  shadow: {
    panel: '0 4px 20px var(--color-overlay-backdrop)',
    popup: '0 6px 18px var(--color-overlay-backdrop)',
  },
  motion: { fast: '140ms' },
};
