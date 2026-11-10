// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  clampFontSize,
  directoryFromOsc,
  fontSizeChoices,
  maxFontSize,
  minFontSize,
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
  it('accepts drive and share paths only for local Windows shells', () => {
    expect(directoryFromOsc('C:\\Users\\me', false, true)).toBe('C:\\Users\\me');
    expect(directoryFromOsc('D:/work', false, true)).toBe('D:/work');
    for (const share of [
      '\\\\attacker\\share',
      '//attacker/share',
      '/\\attacker\\share',
      '\\/attacker/share',
    ])
      expect(directoryFromOsc(share, false, true)).toBeNull();
    expect(directoryFromOsc('file:////attacker/share', true, true)).toBeNull();
    // An SSH tab's `//srv` is an ordinary server path and opens nothing on this PC.
    expect(directoryFromOsc('//srv/app', false)).toBe('//srv/app');
    expect(directoryFromOsc('file://host/C:/Users/me', true, true)).toBe('C:/Users/me');
    expect(directoryFromOsc('/usr/local', false, true)).toBe('/usr/local');
    expect(directoryFromOsc('C:\\Users\\me', false)).toBeNull();
    expect(directoryFromOsc('relative', false, true)).toBeNull();
    expect(directoryFromOsc('C:\\bad\x07', false, true)).toBeNull();
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
  it('offers the current font size even when it is not a preset', () => {
    expect(fontSizeChoices(14)).toEqual([12, 14, 16, 18, 20, 24]);
    expect(fontSizeChoices(15)).toEqual([12, 14, 15, 16, 18, 20, 24]);
    expect(fontSizeChoices(8)).toEqual([8, 12, 14, 16, 18, 20, 24]);
  });
  it('limits font sizes to the supported range', () => {
    expect(clampFontSize(minFontSize - 1)).toBe(minFontSize);
    expect(clampFontSize(maxFontSize + 500)).toBe(maxFontSize);
    expect(clampFontSize(14.4)).toBe(14);
  });
  it('persists explicit on/off choices and backspace compatibility', () => {
    saveTerminalPreferences({
      copyOnSelect: false,
      rightClickPaste: false,
      followDirectory: false,
      backspace: 'bs',
      macOptionAsMeta: true,
      programStatus: false,
      clipboardWrite: false,
      osNotifications: false,
      bellNotifications: false,
      programGuide: false,
      gitStatus: false,
      promptBranch: 'off',
      longCommandNotify: 0,
    });
    expect(JSON.parse(localStorage.getItem('dachsterm.terminalPreferences')!)).toEqual({
      copyOnSelect: false,
      rightClickPaste: false,
      followDirectory: false,
      backspace: 'bs',
      macOptionAsMeta: true,
      programStatus: false,
      clipboardWrite: false,
      osNotifications: false,
      bellNotifications: false,
      programGuide: false,
      gitStatus: false,
      promptBranch: 'off',
      longCommandNotify: 0,
    });
  });
});
