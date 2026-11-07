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

/** Windows file names cannot contain a double quote, so this cannot be closed early. */
const windowsQuote = (path: string) => (/[\s&()^;,=!'`%]/.test(path) ? `"${path}"` : path);

/** Text to type for dropped files on a local tab, or null when one path has no form there. */
export function localDropText(paths: string[], target: 'shell' | 'wsl', mac: boolean) {
  const typed: string[] = [];
  for (const path of paths) {
    if (isUnc(path)) return null;
    if (target === 'wsl') {
      const converted = wslPath(path);
      if (converted === null) return null;
      typed.push(posixQuote(converted));
    } else typed.push(mac ? posixQuote(path) : windowsQuote(path));
  }
  return typed.join(' ');
}

export const insideRect = (rect: DOMRect, x: number, y: number) =>
  rect.width > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
