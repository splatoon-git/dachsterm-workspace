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
