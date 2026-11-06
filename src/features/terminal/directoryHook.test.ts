// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { atShellPrompt, HookEchoFilter } from './directoryHook';

const marker = '\x1b]1337;DachsTermReady=abc\x07';
const echoStart = 'DachsTermHookabc';
const started = () => {
  const filter = new HookEchoFilter();
  filter.begin(marker, echoStart);
  return filter;
};

describe('atShellPrompt', () => {
  it('accepts common prompts', () => {
    for (const prompt of ['mesim@SNOOPY-PC:/app/mesim$ ', 'root@host:~# ', 'host% ', '❯ ', 'bash$'])
      expect(atShellPrompt(prompt)).toBe(true);
  });
  it('rejects typed input, questions and running output', () => {
    for (const text of ['user@host:~$ ls', 'Password: ', 'Select an option: ', '', 'loading'])
      expect(atShellPrompt(text)).toBe(false);
  });
});

describe('HookEchoFilter', () => {
  it('passes output through until the hook is typed', () => {
    const filter = new HookEchoFilter();
    expect(filter.active).toBe(false);
    expect(filter.push('motd')).toBe('motd');
  });
  it('drops the echo and redraws the prompt in place when the marker arrives', () => {
    const filter = started();
    expect(filter.push(` : ${echoStart}; if [ -n "$BASH_VERSION" ]; then ...\r\n`)).toBe('');
    expect(filter.push(`${marker}\x1b]1337;CurrentDir=/app\x07user$ `)).toBe(
      ' : \r\x1b[2K\x1b]1337;CurrentDir=/app\x07user$ ',
    );
    expect(filter.active).toBe(false);
    expect(filter.push('next')).toBe('next');
  });
  it('finds a marker split across output frames', () => {
    const filter = started();
    expect(filter.push(`${echoStart} echo\x1b]1337;DachsTerm`)).toBe('');
    expect(filter.push('Ready=abc\x07$ ')).toBe('\r\x1b[2K$ ');
  });
  it('does not treat the echoed command text as the marker', () => {
    const filter = started();
    expect(filter.push("printf '\\033]1337;DachsTermReady=abc\\007'")).toBe('');
    expect(filter.active).toBe(true);
  });
  it('keeps output from a command that ran just before the hook', () => {
    const filter = started();
    expect(filter.push('NATIVE_OK\r\nuser$ ')).toBe('');
    expect(filter.push(` : ${echoStart}; hook\r\n${marker}user$ `)).toBe(
      'NATIVE_OK\r\nuser$  : \r\x1b[2Kuser$ ',
    );
  });
  it('shows everything rather than lose output when the echo cannot be located', () => {
    const filter = started();
    expect(filter.push(`styled echo${marker}user$ `)).toBe('styled echouser$ ');
  });
  it('returns held output when the marker never arrives, so nothing is lost', () => {
    const filter = started();
    filter.push('syntax error');
    expect(filter.flush()).toBe('syntax error');
    expect(filter.active).toBe(false);
  });
  it('releases output instead of holding it without limit', () => {
    const filter = started();
    const large = 'x'.repeat(70000);
    expect(filter.push(large)).toBe(large);
    expect(filter.active).toBe(false);
  });
});
