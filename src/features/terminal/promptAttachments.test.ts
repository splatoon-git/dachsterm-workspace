import { describe, expect, it } from 'vitest';
import {
  approveClipboard,
  clipboardApproved,
  insideRect,
  localDropText,
  posixQuote,
  wslPath,
} from './promptAttachments';

describe('prompt attachments', () => {
  it('quotes a path only when a shell would treat it differently', () => {
    expect(posixQuote('/home/u/.cache/dachsterm/prompt/a_b-1.png')).toBe(
      '/home/u/.cache/dachsterm/prompt/a_b-1.png',
    );
    expect(posixQuote('/home/my user/a.png')).toBe("'/home/my user/a.png'");
    expect(posixQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'");
    expect(posixQuote('/tmp/$(reboot)')).toBe("'/tmp/$(reboot)'");
  });

  it('turns drive paths into WSL paths and refuses others', () => {
    expect(wslPath('C:\\Users\\u\\a b.png')).toBe('/mnt/c/Users/u/a b.png');
    expect(wslPath('D:/x.txt')).toBe('/mnt/d/x.txt');
    expect(wslPath('\\\\server\\share\\a')).toBeNull();
    expect(wslPath('relative\\a')).toBeNull();
  });

  it('writes dropped paths in the form the local shell expects', () => {
    expect(localDropText(['C:\\a b\\c.txt', 'C:\\d.txt'], 'shell', false)).toBe(
      '"C:\\a b\\c.txt" C:\\d.txt',
    );
    expect(localDropText(['C:\\a b\\c.txt'], 'wsl', false)).toBe("'/mnt/c/a b/c.txt'");
    expect(localDropText(['/Users/u/a b.png'], 'shell', true)).toBe("'/Users/u/a b.png'");
  });

  it('refuses network paths on every local tab', () => {
    expect(localDropText(['\\\\server\\share\\a'], 'shell', false)).toBeNull();
    expect(localDropText(['C:\\a', '\\\\server\\b'], 'wsl', false)).toBeNull();
    expect(localDropText(['//server/share/a'], 'shell', true)).toBeNull();
  });

  it('remembers approval for one connection only', () => {
    expect(clipboardApproved('one')).toBe(false);
    approveClipboard('one');
    expect(clipboardApproved('one')).toBe(true);
    expect(clipboardApproved('two')).toBe(false);
  });

  it('treats a hidden pane as outside every drop', () => {
    const rect = (width: number) =>
      ({ left: 10, top: 10, right: 10 + width, bottom: 10 + width, width }) as DOMRect;
    expect(insideRect(rect(100), 50, 50)).toBe(true);
    expect(insideRect(rect(100), 5, 50)).toBe(false);
    expect(insideRect(rect(0), 10, 10)).toBe(false);
  });
});
