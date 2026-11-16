import type { Profile, SerialSettings } from '../../lib/ipc';

export type Protocol = Profile['protocol'];
export const defaultPorts: Record<Protocol, number> = {
  ssh: 22,
  ftp: 21,
  ftps: 21,
  telnet: 23,
  serial: 0,
};
/** What most consoles use: 115200 baud, 8 data bits, no parity, 1 stop bit, no flow control. */
export const defaultSerial: SerialSettings = {
  baud: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  flow: 'none',
};

/** `115200 8N1`, as a console's label says it, with flow control when there is one. */
export function serialLabel(p: Pick<Profile, 'serial'>) {
  const s = p.serial ?? defaultSerial;
  const flow = { none: '', software: ' · XON/XOFF', hardware: ' · RTS/CTS' }[s.flow];
  return `${s.baud} ${s.dataBits}${s.parity[0].toUpperCase()}${s.stopBits}${flow}`;
}

/**
 * The profile after the form switches its protocol. What only SSH has is dropped, a default port
 * follows the protocol, FTP logs in with a password, and Telnet and serial with nothing: their
 * login is typed in the terminal, so they keep no password or key (CG.4, CG.5). A device name
 * and a host name do not carry over between serial and the rest.
 */
export function switchProtocol(p: Profile, protocol: Protocol): Profile {
  const ssh = protocol === 'ssh';
  const auth: Profile['auth'] = ssh
    ? p.protocol === 'ssh' || !p.protocol
      ? p.auth
      : 'password'
    : protocol === 'telnet' || protocol === 'serial'
      ? 'interactive'
      : 'password';
  const serial = protocol === 'serial';
  return {
    ...p,
    protocol,
    host: serial === (p.protocol === 'serial') ? p.host : '',
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
    serial: serial ? (p.serial ?? defaultSerial) : null,
  };
}
