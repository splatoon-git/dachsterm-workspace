import { describe, expect, it } from 'vitest';
import { themes } from '../../themes/registry';
import {
  blankRule,
  highlightHex,
  matchesSecretPrompt,
  ruleApplies,
  ruleError,
  triggerInput,
  type HighlightRule,
} from './highlightRules';

const rule = (patch: Partial<HighlightRule>): HighlightRule => ({
  ...blankRule(),
  name: '규칙',
  pattern: 'ERROR',
  ...patch,
});

describe('highlight rules', () => {
  it('apply by scope and only when enabled', () => {
    const target = { profileId: 'p1', tags: ['db'] };
    expect(ruleApplies(rule({}), target)).toBe(true);
    expect(ruleApplies(rule({ enabled: false }), target)).toBe(false);
    expect(ruleApplies(rule({ scope: { kind: 'tags', tags: ['web', 'db'] } }), target)).toBe(true);
    expect(ruleApplies(rule({ scope: { kind: 'tags', tags: ['web'] } }), target)).toBe(false);
    expect(ruleApplies(rule({ scope: { kind: 'sessions', ids: ['p1'] } }), target)).toBe(true);
    // A local shell has no saved session.
    const local = { profileId: null, tags: [] };
    expect(ruleApplies(rule({ scope: { kind: 'sessions', ids: ['p1'] } }), local)).toBe(false);
  });

  it('refuse typed answers to password prompts, however the pattern is written', () => {
    for (const pattern of [
      '[Pp]assword:',
      '.*:\\s*$',
      'sudo\\]',
      'passphrase',
      'Verification',
      '암호',
      '비밀번호',
    ])
      expect(matchesSecretPrompt(pattern, true), pattern).toBe(true);
    expect(matchesSecretPrompt('Continue\\? \\[y/N\\]', false)).toBe(false);
    const send = { text: 'y\n', confirmedAt: 1 };
    expect(ruleError(rule({ pattern: '[Pp]assword', send }))).toMatch(/암호/);
    expect(ruleError(rule({ pattern: 'Continue\\?', send }))).toBeNull();
  });

  it('report what cannot be saved', () => {
    expect(ruleError(rule({ name: ' ' }))).toMatch(/이름/);
    expect(ruleError(rule({ pattern: '(' }))).toMatch(/정규식/);
    expect(ruleError(rule({ color: null }))).toMatch(/하나를/);
    expect(ruleError(rule({ scope: { kind: 'tags', tags: [] } }))).toMatch(/태그/);
    expect(
      ruleError(rule({ pattern: 'Continue', send: { text: 'y\x1b', confirmedAt: 1 } })),
    ).toMatch(/제어문자/);
  });

  it('take colors from each theme terminal palette as #RRGGBB', () => {
    for (const theme of themes) {
      expect(highlightHex(theme, 'danger')).toBe(theme.terminal.red);
      expect(highlightHex(theme, 'info')).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('type line breaks as Enter', () => {
    expect(triggerInput('y\nyes\r\n')).toBe('y\ryes\r');
  });
});
