import { describe, expect, it } from 'vitest';
import {
  approveClipboard,
  clipboardApproved,
  dropShell,
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
    expect(localDropText(['C:\\a b\\c.txt', 'C:\\d.txt'], 'cmd')).toBe(
      '"C:\\a b\\c.txt" C:\\d.txt',
    );
    expect(localDropText(['C:\\a b\\c.txt', 'C:\\d.txt'], 'powershell')).toBe(
      "'C:\\a b\\c.txt' C:\\d.txt",
    );
    expect(localDropText(['C:\\a b\\c.txt'], 'wsl')).toBe("'/mnt/c/a b/c.txt'");
    expect(localDropText(['/Users/u/a b.png'], 'posix')).toBe("'/Users/u/a b.png'");
  });

  // S.6: double quotes, which suit cmd, let PowerShell run `$()` once the user presses Enter.
  it('keeps PowerShell from running anything in a dropped file name', () => {
    expect(localDropText(['C:\\dl\\$(calc).txt'], 'powershell')).toBe("'C:\\dl\\$(calc).txt'");
    expect(localDropText(['C:\\dl\\a`$b $env:X.txt'], 'powershell')).toBe(
      "'C:\\dl\\a`$b $env:X.txt'",
    );
    // A straight or typographic quote would otherwise end the string early.
    expect(localDropText(["C:\\dl\\'; calc; '.txt"], 'powershell')).toBe(
      "'C:\\dl\\''; calc; ''.txt'",
    );
    expect(localDropText(['C:\\dl\\\u2019; calc; \u2018.txt'], 'powershell')).toBe(
      "'C:\\dl\\\u2019\u2019; calc; \u2018\u2018.txt'",
    );
  });

  it('picks the quoting of the tab it is dropped on', () => {
    expect(dropShell({ id: 'pwsh', kind: 'shell' }, false)).toBe('powershell');
    expect(dropShell({ id: 'powershell', kind: 'shell' }, false)).toBe('powershell');
    expect(dropShell({ id: 'cmd', kind: 'shell' }, false)).toBe('cmd');
    expect(dropShell({ id: 'wsl:Ubuntu', kind: 'wsl' }, false)).toBe('wsl');
    expect(dropShell({ id: 'default-shell', kind: 'shell' }, true)).toBe('posix');
  });

  it('refuses network paths on every local tab', () => {
    expect(localDropText(['\\\\server\\share\\a'], 'powershell')).toBeNull();
    expect(localDropText(['\\\\server\\share\\a'], 'cmd')).toBeNull();
    expect(localDropText(['C:\\a', '\\\\server\\b'], 'wsl')).toBeNull();
    expect(localDropText(['//server/share/a'], 'posix')).toBeNull();
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
