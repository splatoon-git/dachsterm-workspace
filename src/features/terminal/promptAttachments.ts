/** Decides how an image or a file reaches a program's prompt. Nothing here touches the terminal. */
export type AttachItem = { name: string; size: number };
export type ClipboardImage = { item: AttachItem; digest: string };
export type PendingAttachment = { id: string } & (
  | { kind: 'clipboard'; items: AttachItem[]; digest: string }
  | { kind: 'files'; items: AttachItem[]; paths: string[] }
);

/** Shown to the user. The real location is resolved from the server's home folder. */
export const promptFolder = '~/.cache/dachsterm/prompt/';

/** Memory only and per connection, so a reconnect or a restart asks again. */
const approved = new Set<string>();
export const clipboardApproved = (connectionId: string) => approved.has(connectionId);
export const approveClipboard = (connectionId: string) => void approved.add(connectionId);

import { posixQuote } from '../../lib/shell';
export { posixQuote };

const isUnc = (path: string) => /^[\\/]{2}/.test(path);

/** A Windows path as WSL sees it, or null when WSL has no such path. */
export function wslPath(path: string) {
  const match = /^([A-Za-z]):[\\/](.*)$/s.exec(path);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}` : null;
}

/** How a local tab's shell reads a typed path. Each quotes differently, so none can stand in. */
export type DropShell = 'posix' | 'wsl' | 'powershell' | 'cmd';

/** Windows tabs are only `pwsh`, `powershell`, `cmd` and `wsl:<name>` (`local.rs`). */
export function dropShell(target: { id: string; kind: 'shell' | 'wsl' }, mac: boolean): DropShell {
  if (target.kind === 'wsl') return 'wsl';
  if (mac) return 'posix';
  return target.id === 'cmd' ? 'cmd' : 'powershell';
}

/**
 * cmd has no quoting that stops `%name%`, but expanding a variable cannot run anything, and a
 * Windows file name cannot contain a double quote, so the quotes cannot be closed early.
 */
const cmdQuote = (path: string) => (/[\s&()^;,=!'`%]/.test(path) ? `"${path}"` : path);

/**
 * PowerShell expands `$()` and backtick escapes inside double quotes, so only single quotes are
 * safe. It also closes a single-quoted string at the typographic quotes U+2018..U+201B, which are
 * legal in Windows file names; every one of them is doubled, as PowerShell's own escaper does.
 */
const powershellQuote = (path: string) =>
  /^[A-Za-z0-9_.:\\/-]+$/.test(path) ? path : `'${path.replace(/['\u2018-\u201b]/g, '$&$&')}'`;

/** Text to type for dropped files on a local tab, or null when one path has no form there. */
export function localDropText(paths: string[], shell: DropShell) {
  const typed: string[] = [];
  for (const path of paths) {
    if (isUnc(path)) return null;
    if (shell === 'wsl') {
      const converted = wslPath(path);
      if (converted === null) return null;
      typed.push(posixQuote(converted));
    } else if (shell === 'posix') typed.push(posixQuote(path));
    else typed.push(shell === 'cmd' ? cmdQuote(path) : powershellQuote(path));
  }
  return typed.join(' ');
}

export const insideRect = (rect: DOMRect, x: number, y: number) =>
  rect.width > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
