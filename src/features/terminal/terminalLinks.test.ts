// @vitest-environment jsdom
import { Terminal } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';
import { parseOsc52 } from './osc52';
import { attachTerminalLinks, classifyLink, findUrls } from './terminalLinks';

// jsdom has no canvas and reports that on stderr. These tests never draw.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe('terminal links', () => {
  it('finds web addresses and leaves out sentence punctuation', () => {
    expect(
      findUrls('see https://example.com/a?b=1, then (http://x.test/y).').map((u) => u.url),
    ).toEqual(['https://example.com/a?b=1', 'http://x.test/y']);
    expect(findUrls('file:///etc/passwd ftp://x')).toEqual([]);
  });

  it('sends loopback addresses from a server to the tunnel path', () => {
    for (const url of [
      'http://localhost:3000/',
      'http://127.0.0.1:8080',
      'http://0.0.0.0:80',
      'http://[::1]:5173/',
    ]) {
      expect(classifyLink(url, true)).toBe('server');
      expect(classifyLink(url, false)).toBe('open');
    }
    expect(classifyLink('https://example.com', true)).toBe('open');
  });

  it('blocks other schemes and links that hide a host', () => {
    expect(classifyLink('file:///etc/passwd', false)).toBe('blocked');
    expect(classifyLink('https://user:pw@example.com', false)).toBe('blocked');
    expect(classifyLink('not a url', false)).toBe('blocked');
  });

  async function linksAt(content: string, y: number, cols = 20) {
    const terminal = new Terminal({ cols, rows: 6, allowProposedApi: false });
    const provider = vi.spyOn(terminal, 'registerLinkProvider');
    attachTerminalLinks(terminal, { remote: () => false, notice: vi.fn() });
    await new Promise<void>((resolve) => terminal.write(content, resolve));
    return new Promise<{ text: string; range: unknown }[] | undefined>((resolve) =>
      provider.mock.calls[0][0].provideLinks(y, resolve),
    );
  }

  it('maps a soft-wrapped link to the cells on every row', async () => {
    const url = 'https://example.com/long/path';
    const expected = {
      text: url,
      range: { start: { x: 1, y: 1 }, end: { x: 9, y: 2 } },
    };
    expect((await linksAt(url, 1))?.[0]).toMatchObject(expected);
    expect((await linksAt(url, 2))?.[0]).toMatchObject(expected);
  });

  it('keeps cell positions correct after wide characters', async () => {
    const links = await linksAt('한글 https://a.test', 1, 40);
    expect(links?.[0]).toMatchObject({
      text: 'https://a.test',
      range: { start: { x: 6, y: 1 }, end: { x: 19, y: 1 } },
    });
  });

  it('finds nothing on other lines', async () => {
    expect(await linksAt('plain\r\nhttps://a.test', 1)).toBeUndefined();
  });
});

describe('OSC 52', () => {
  it('reads the clipboard target and an empty target', () => {
    expect(parseOsc52(`c;${b64('복사')}`)).toBe('복사');
    expect(parseOsc52(`;${b64('x')}`)).toBe('x');
    expect(parseOsc52(`pc;${b64('x')}`)).toBe('x');
  });

  it('refuses reads, other targets and invalid data', () => {
    expect(parseOsc52('c;?')).toBeNull();
    expect(parseOsc52(`p;${b64('x')}`)).toBeNull();
    expect(parseOsc52('c;')).toBeNull();
    expect(parseOsc52('c;***')).toBeNull();
    expect(parseOsc52('nothing')).toBeNull();
    expect(parseOsc52(`c;${btoa('\xff\xfe')}`)).toBeNull();
  });

  it('enforces the size limit', () => {
    expect(parseOsc52(`c;${'A'.repeat(1_500_000)}`)).toBeNull();
  });
});
