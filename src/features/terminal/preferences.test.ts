// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  directoryFromOsc,
  needsPasteConfirmation,
  saveTerminalDisplay,
  saveTerminalPreferences,
  subscribeTerminalPreferences,
  terminalDisplay,
} from './preferences';

describe('terminal paths and clipboard safety', () => {
  it('accepts remote absolute paths without interpreting them as local URLs', () => {
    expect(directoryFromOsc('file://remote/home/%ED%95%9C%EA%B8%80%20dir')).toBe('/home/한글 dir');
    expect(directoryFromOsc('/tmp/100% done', false)).toBe('/tmp/100% done');
    for (const invalid of [
      'https://host/path',
      'file://host/a%00b',
      'file://host/a%0ab',
      'file://host/bad%xx',
      'file://host/a?x=y',
      'file://host/a#fragment',
    ])
      expect(directoryFromOsc(invalid)).toBeNull();
    expect(directoryFromOsc('relative', false)).toBeNull();
    expect(directoryFromOsc('/' + 'x'.repeat(4096), false)).toBeNull();
  });
  it('requires confirmation for line endings and terminal controls but permits tabs', () => {
    for (const value of ['echo ok\n', '\r', '\x1b[200~payload', '\x03', '\x00', '\x7f'])
      expect(needsPasteConfirmation(value)).toBe(true);
    expect(needsPasteConfirmation('한글 hello\tworld')).toBe(false);
  });
  it('notifies panes in the same window when font size or scrollback changes', () => {
    let notified = 0;
    const stop = subscribeTerminalPreferences(() => notified++);
    saveTerminalDisplay({ fontSize: 18 });
    saveTerminalDisplay({ scrollback: 1000 });
    stop();
    expect(notified).toBe(2);
    expect(terminalDisplay()).toEqual({ fontSize: 18, scrollback: 1000 });
    expect(localStorage.getItem('dachsterm.fontSize')).toBe('18');
    expect(localStorage.getItem('dachsterm.scrollback')).toBe('1000');
  });
  it('persists explicit on/off choices and backspace compatibility', () => {
    saveTerminalPreferences({
      copyOnSelect: false,
      rightClickPaste: false,
      followDirectory: false,
      backspace: 'bs',
    });
    expect(JSON.parse(localStorage.getItem('dachsterm.terminalPreferences')!)).toEqual({
      copyOnSelect: false,
      rightClickPaste: false,
      followDirectory: false,
      backspace: 'bs',
    });
  });
});
