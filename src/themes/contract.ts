export type StateTokens = {
  default: string;
  hover: string;
  active: string;
  selected: string;
  disabled: string;
  focus: string;
};
export type Foundations = {
  space: { xs: string; sm: string; md: string; lg: string; xl: string; xxl: string };
  font: { ui: string; mono: string; small: string; body: string; title: string };
  radius: { small: string; medium: string; large: string };
  borderWidth: { default: string; focus: string };
  shadow: { panel: string };
  motion: { fast: string };
};
export type ThemeDefinition = {
  id: string;
  name: string;
  description: string;
  category: '기본' | '화이트' | '다크' | '레트로' | '터미널';
  colorScheme: 'light' | 'dark';
  foundations: Foundations;
  color: {
    surface: { app: string; panel: string; subtle: string; header: string };
    text: { primary: string; secondary: string; onAction: string; disabled: string };
    border: { default: string; subtle: string; input: string };
    action: StateTokens & { primary: string; accent: string; onAccent: string };
    status: { success: string; info: string; warning: string; error: string };
    focus: { ring: string };
    overlay: { backdrop: string };
  };
  terminal: {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
    selectionForeground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
  chart: {
    series: readonly [string, string, string, string];
    axis: string;
    grid: string;
    tooltip: string;
    tooltipText: string;
  };
};
