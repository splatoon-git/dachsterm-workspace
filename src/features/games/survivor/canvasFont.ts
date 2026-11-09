import type { ThemeDefinition } from '../../../themes/contract';

type Size = 'caption' | 'body' | 'large' | 'heading' | 'display';

/** Canvas cannot read CSS variables, so its text takes the same foundation tokens directly. */
export function canvasFont(theme: ThemeDefinition, size: Size, bold = false) {
  const { font } = theme.foundations;
  return `${bold ? font.weightBold : font.weightNormal} ${font[size]} ${font.ui}`;
}
