import type { ThemeDefinition } from '../../themes/contract';

/** A theme token name. The color itself always comes from the current theme (roadmap §2.3). */
export type HighlightColor = 'danger' | 'warning' | 'success' | 'info' | 'accent';
export type HighlightScope =
  { kind: 'all' } | { kind: 'tags'; tags: string[] } | { kind: 'sessions'; ids: string[] };
/** Saved by `highlights.rs`, which checks the same limits. */
export type HighlightRule = {
  id: string;
  name: string;
  /** A JavaScript regular expression's source. */
  pattern: string;
  ignoreCase: boolean;
  scope: HighlightScope;
  color: HighlightColor | null;
  notify: boolean;
  /** Typed when the rule matches. Only a rule the user turned this on for, after a warning. */
  send: { text: string; confirmedAt: number } | null;
  enabled: boolean;
};
export type HighlightLibrary = { revision: number; items: HighlightRule[] };

export const maxRules = 64;
export const maxPattern = 512;
export const maxSendText = 1024;

export const highlightColors: { value: HighlightColor; label: string }[] = [
  { value: 'danger', label: '위험 (빨강)' },
  { value: 'warning', label: '주의 (노랑)' },
  { value: 'success', label: '성공 (초록)' },
  { value: 'info', label: '정보 (파랑)' },
  { value: 'accent', label: '강조 (자주)' },
];

/**
 * The terminal palette's colors, which each theme keeps readable on its terminal background. The
 * UI status colors are chosen for panels and may not be.
 */
const paletteOf: Record<HighlightColor, keyof ThemeDefinition['terminal']> = {
  danger: 'red',
  warning: 'yellow',
  success: 'green',
  info: 'blue',
  accent: 'magenta',
};

/** xterm decorations take `#RRGGBB` only; anything else falls back to the text color. */
export function highlightHex(theme: ThemeDefinition, color: HighlightColor) {
  const value = theme.terminal[paletteOf[color]];
  return /^#[0-9a-f]{6}$/i.test(value) ? value : theme.terminal.foreground;
}

/** What a rule's scope is checked against. A tab without a saved session has no tags or ID. */
export type HighlightTarget = { profileId: string | null; tags: readonly string[] };

export function ruleApplies(rule: HighlightRule, target: HighlightTarget) {
  if (!rule.enabled) return false;
  switch (rule.scope.kind) {
    case 'all':
      return true;
    case 'tags':
      return rule.scope.tags.some((tag) => target.tags.includes(tag));
    case 'sessions':
      return target.profileId !== null && rule.scope.ids.includes(target.profileId);
  }
}

/** Prompts a typed answer must never reach. The backend refuses the words themselves too. */
const secretPrompts = [
  'Password:',
  'password: ',
  '[sudo] password for user:',
  "Password for 'https://git.example.com':",
  'Enter passphrase for key /home/user/.ssh/id_ed25519:',
  'Enter PIN for key:',
  'Verification code:',
  '암호:',
  '비밀번호:',
];
const secretWords = ['ssword', 'asswd', 'passphrase', '암호', '비밀번호', '비번'];

/** Null when the pattern compiles, or why it does not. */
export function patternError(pattern: string, ignoreCase: boolean): string | null {
  if (!pattern) return '패턴을 입력하세요.';
  if (pattern.length > maxPattern) return `패턴은 ${maxPattern}자 이하여야 합니다.`;
  try {
    new RegExp(pattern, ignoreCase ? 'gi' : 'g');
    return null;
  } catch {
    return '정규식 형식이 올바르지 않습니다.';
  }
}

/** True when typing on this rule's match could answer a password, passphrase or code prompt. */
export function matchesSecretPrompt(pattern: string, ignoreCase: boolean) {
  const letters = pattern.toLowerCase().replace(/[[\](){}?*+|\\^$.]/g, '');
  if (secretWords.some((word) => letters.includes(word))) return true;
  try {
    const expression = new RegExp(pattern, ignoreCase ? 'i' : '');
    return secretPrompts.some((prompt) => expression.test(prompt));
  } catch {
    return false;
  }
}

/** Text a trigger types. Line breaks become the Enter a terminal sends. */
export const triggerInput = (text: string) => text.replace(/\r\n|\n/g, '\r');

/** Why a rule cannot be saved as it is, or null. Mirrors the backend's checks. */
export function ruleError(rule: HighlightRule): string | null {
  if (!rule.name.trim()) return '규칙 이름을 입력하세요.';
  if (rule.name.trim().length > 100) return '규칙 이름은 100자 이하여야 합니다.';
  const pattern = patternError(rule.pattern, rule.ignoreCase);
  if (pattern) return pattern;
  if (rule.scope.kind === 'tags' && !rule.scope.tags.length) return '태그를 하나 이상 입력하세요.';
  if (rule.scope.kind === 'sessions' && !rule.scope.ids.length) return '세션을 하나 이상 고르세요.';
  if (!rule.color && !rule.notify && !rule.send) return '색, 알림, 입력 보내기 중 하나를 켜세요.';
  if (rule.send) {
    if (matchesSecretPrompt(rule.pattern, rule.ignoreCase))
      return '암호를 묻는 줄과 일치하는 규칙에는 입력 보내기를 켤 수 없습니다.';
    const { text } = rule.send;
    if (!text) return '보낼 입력을 적으세요.';
    if (new TextEncoder().encode(text).length > maxSendText) return '보낼 입력은 1KiB 이하입니다.';
    // eslint-disable-next-line no-control-regex -- control characters are what is refused.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text))
      return 'Tab·줄바꿈 이외 제어문자는 보낼 수 없습니다.';
  }
  return null;
}

export const blankRule = (): HighlightRule => ({
  id: crypto.randomUUID(),
  name: '',
  pattern: '',
  ignoreCase: true,
  scope: { kind: 'all' },
  color: 'danger',
  notify: false,
  send: null,
  enabled: true,
});

/** A trigger may type into the same tab once in this many milliseconds. */
export const triggerIntervalMs = 10_000;
