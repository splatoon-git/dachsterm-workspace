import { describe, expect, it } from 'vitest';
import { blankProfile, type Profile } from '../../lib/ipc';
import { defaultSerial, needsUsername, serialLabel, switchProtocol } from './protocol';

const ssh: Profile = {
  ...blankProfile(),
  auth: 'key',
  keyPath: '/k',
  jumpIds: ['j'],
  tmuxSession: 'main',
  forwardAgent: true,
  proxy: { kind: 'socks5', host: 'p', port: 1080, username: '' },
  certPath: '/k-cert.pub',
  agentSource: 'pageant',
  forwardX11: true,
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
      certPath: '',
      agentSource: 'system',
      forwardX11: false,
    });
  });

  it('logs FTP in with a password and comes back to SSH with a password, not Telnet login', () => {
    expect(switchProtocol(ssh, 'ftp')).toMatchObject({ port: 21, auth: 'password' });
    const back = switchProtocol(switchProtocol(ssh, 'telnet'), 'ssh');
    expect(back).toMatchObject({ port: 22, auth: 'password' });
    expect(switchProtocol(ssh, 'ssh')).toMatchObject({ auth: 'key', certPath: '/k-cert.pub' });
    expect(switchProtocol(ssh, 'ftp')).toMatchObject({ certPath: '', forwardX11: false });
  });

  it('turns a session into a serial console with the common line settings and no host', () => {
    const serial = switchProtocol({ ...ssh, host: 'server.example' }, 'serial');
    expect(serial).toMatchObject({ protocol: 'serial', host: '', port: 0, auth: 'interactive' });
    expect(serial.serial).toEqual(defaultSerial);
    expect(serialLabel(serial)).toBe('115200 8N1');
    // Leaving serial drops the device name and the line settings.
    const back = switchProtocol({ ...serial, host: '/dev/cu.usbserial' }, 'telnet');
    expect(back).toMatchObject({ host: '', port: 23, serial: null });
    const tuned = {
      ...serial,
      serial: { ...defaultSerial, parity: 'even' as const, flow: 'hardware' as const },
    };
    expect(serialLabel(tuned)).toBe('115200 8E1 · RTS/CTS');
  });

  it('keeps a port the user chose', () => {
    expect(switchProtocol({ ...ssh, port: 2323 }, 'telnet').port).toBe(2323);
  });
});

describe('needsUsername', () => {
  it('asks only FTP for a saved user: SSH asks when it connects', () => {
    expect(['ftp', 'ftps'].every((protocol) => needsUsername({ protocol } as Profile))).toBe(true);
    expect(needsUsername({ protocol: 'ssh' })).toBe(false);
    expect(needsUsername({ protocol: 'telnet' })).toBe(false);
    expect(needsUsername({ protocol: 'serial' })).toBe(false);
  });
});
