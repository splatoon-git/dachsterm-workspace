import { test } from '@playwright/test';
import { colorsFollowTheme } from './highlightCases';

// The macOS app's view runs JavaScriptCore; the module worker and decorations must work there too.
test('WebKit: a highlight rule colors matches and follows a theme change', ({ page }) =>
  colorsFollowTheme(page));
