import type { TerminalLaunch } from './ipc';

/** POSIX single quoting. Plain paths stay as they are so the typed text reads naturally. */
export function posixQuote(path: string) {
  return /^[A-Za-z0-9_./@%+=:,-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * The line typed at a shell prompt to start a command in a folder. Bash, Zsh and fish all read it
 * the same way. The folder is absolute, so it can never be taken for an option of `cd`.
 */
export function startLine({ folder, command }: TerminalLaunch) {
  return folder ? `cd ${posixQuote(folder)} && ${command}` : command;
}

/**
 * A server folder for an agent to start in, or why it cannot be used. Empty means the login
 * folder. Agent start (DX.7) and agent chat (AC.1) share it; the chat backend checks the same.
 */
export function folderProblem(folder: string): string | null {
  if (!folder) return null;
  if (!folder.startsWith('/')) return '서버 폴더는 /로 시작하는 경로로 입력하세요.';
  if (/\p{Cc}/u.test(folder) || folder.length > 4096) return '폴더 경로를 확인하세요.';
  return null;
}
