import type { Profile } from '../../lib/ipc';

export type Protocol = Profile['protocol'];
export const defaultPorts: Record<Protocol, number> = { ssh: 22, ftp: 21, ftps: 21, telnet: 23 };

/**
 * The profile after the form switches its protocol. What only SSH has is dropped, a default port
 * follows the protocol, FTP logs in with a password, and Telnet with nothing: its login is typed
 * in the terminal, so it keeps no password or key (CG.4).
 */
export function switchProtocol(p: Profile, protocol: Protocol): Profile {
  const ssh = protocol === 'ssh';
  const auth: Profile['auth'] = ssh
    ? p.protocol === 'ssh' || !p.protocol
      ? p.auth
      : 'password'
    : protocol === 'telnet'
      ? 'interactive'
      : 'password';
  return {
    ...p,
    protocol,
    port: Object.values(defaultPorts).includes(p.port) ? defaultPorts[protocol] : p.port,
    auth,
    keyPath: auth === 'key' ? p.keyPath : '',
    jumpIds: ssh ? p.jumpIds : [],
    tmuxSession: ssh ? p.tmuxSession : '',
    forwardAgent: ssh && p.forwardAgent,
    forwardKeys: ssh ? p.forwardKeys : [],
    forwardGitCredentials: ssh && p.forwardGitCredentials,
    workspace: ssh ? p.workspace : 'terminal',
    proxy: ssh ? p.proxy : null,
  };
}
