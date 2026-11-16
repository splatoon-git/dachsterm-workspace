import { describe, expect, it } from 'vitest';
import { blankProfile, type Profile } from '../../lib/ipc';
import { switchProtocol } from './protocol';

const ssh: Profile = {
  ...blankProfile(),
  auth: 'key',
  keyPath: '/k',
  jumpIds: ['j'],
  tmuxSession: 'main',
  forwardAgent: true,
  proxy: { kind: 'socks5', host: 'p', port: 1080, username: '' },
};

describe('switchProtocol', () => {
  it('turns a session into Telnet without a password, key or anything only SSH has', () => {
    const telnet = switchProtocol(ssh, 'telnet');
    expect(telnet).toMatchObject({
      protocol: 'telnet',
      port: 23,
      auth: 'interactive',
      keyPath: '',
      jumpIds: [],
      tmuxSession: '',
      forwardAgent: false,
      proxy: null,
    });
  });

  it('logs FTP in with a password and comes back to SSH with a password, not Telnet login', () => {
    expect(switchProtocol(ssh, 'ftp')).toMatchObject({ port: 21, auth: 'password' });
    const back = switchProtocol(switchProtocol(ssh, 'telnet'), 'ssh');
    expect(back).toMatchObject({ port: 22, auth: 'password' });
    expect(switchProtocol(ssh, 'ssh').auth).toBe('key');
  });

  it('keeps a port the user chose', () => {
    expect(switchProtocol({ ...ssh, port: 2323 }, 'telnet').port).toBe(2323);
  });
});
