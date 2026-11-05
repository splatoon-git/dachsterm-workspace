import { lightTheme } from './presets/light';
import type { ThemeDefinition } from './contract';
import {
  whiteTheme,
  darkTheme,
  draculaTheme,
  nordTheme,
  catppuccinTheme,
  gruvboxLightTheme,
  gruvboxDarkTheme,
  solarizedLightTheme,
  solarizedDarkTheme,
  greenTheme,
  amberTheme,
} from './presets/collection';
export const themes: readonly ThemeDefinition[] = [
  lightTheme,
  whiteTheme,
  darkTheme,
  draculaTheme,
  nordTheme,
  catppuccinTheme,
  gruvboxLightTheme,
  gruvboxDarkTheme,
  solarizedLightTheme,
  solarizedDarkTheme,
  greenTheme,
  amberTheme,
];
export const defaultTheme = lightTheme;
export function getTheme(id?: string | null): ThemeDefinition {
  return themes.find((theme) => theme.id === id) ?? defaultTheme;
}
