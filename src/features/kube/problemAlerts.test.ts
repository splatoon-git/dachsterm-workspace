// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { alertMessage, readAlertPref, writeAlertPref } from './problemAlerts';
import type { Problem } from './problems';

const problem = (name: string, detail = 'NotReady'): Problem => ({
  key: `node:${name}`,
  kind: 'node',
  health: 'error',
  object: name,
  detail,
  target: null,
});

describe('the alert switch', () => {
  beforeEach(() => localStorage.clear());

  it('is off until the session turns it on, for that session only', () => {
    expect(readAlertPref('a')).toBe(false);
    writeAlertPref('a', true);
    expect(readAlertPref('a')).toBe(true);
    expect(readAlertPref('b')).toBe(false);
    writeAlertPref('a', false);
    expect(readAlertPref('a')).toBe(false);
  });

  it('remembers nothing for a tab without a saved session', () => {
    writeAlertPref('', true);
    expect(readAlertPref('')).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('accepts only the value it wrote', () => {
    localStorage.setItem('dachsterm.kube.alerts.a', 'yes');
    expect(readAlertPref('a')).toBe(false);
  });
});

describe('the alert text', () => {
  it('names the session in the title and the problems in the body', () => {
    expect(alertMessage('prod', [problem('n1'), problem('n2', 'x')])).toEqual({
      title: 'prod — 쿠버네티스 문제 2건',
      body: 'n1 NotReady · n2 x',
    });
  });

  it('shortens a long batch and says how many it left out', () => {
    const { title, body } = alertMessage(
      'prod',
      Array.from({ length: 8 }, (_, i) => problem(`n${i}`)),
    );
    expect(title).toBe('prod — 쿠버네티스 문제 8건');
    expect(body).toBe('n0 NotReady · n1 NotReady · n2 NotReady · n3 NotReady · n4 NotReady 외 3건');
  });

  it('keeps hidden characters from cluster text out of the body', () => {
    expect(alertMessage('prod', [problem('n‮1', 'bad\u0007')]).body).toBe('n1 bad');
  });
});
