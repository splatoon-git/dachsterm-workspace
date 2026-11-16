import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blankProfile, call, type PodTerminalLaunch } from '../../lib/ipc';
import type { LocalTarget } from './sessionTypes';
import {
  localTransport,
  podTransport,
  remoteTransport,
  type OpenRequest,
  type TerminalTransport,
} from './transport';

vi.mock('../../lib/ipc', async (original) => ({
  ...(await original<typeof import('../../lib/ipc')>()),
  call: vi.fn(() => Promise.resolve()),
}));

const ssh = { ...blankProfile(), id: 'p1', protocol: 'ssh' as const };
const ftp = { ...ssh, protocol: 'ftps' as const };
const shell: LocalTarget = { id: 'pwsh', name: 'PowerShell', kind: 'shell', follow: 'launch' };
const wsl: LocalTarget = { id: 'wsl:U', name: 'Ubuntu', kind: 'wsl', follow: 'typed' };
const launch: PodTerminalLaunch = {
  kind: 'podShell',
  connection: 'c',
  kube: { context: 'c', namespace: 'n', kubectl: 'kubectl', kubeconfig: '', operate: false },
  namespace: 'n',
  pod: 'web-1',
  container: 'app',
};
const onEvent = {} as OpenRequest['onEvent'];
const request: OpenRequest = {
  id: 'x',
  profile: ssh,
  secret: 's',
  remember: true,
  cols: 80,
  rows: 24,
  onEvent,
};

/** Every IPC call one transport makes, in order. */
async function commands(transport: TerminalTransport) {
  vi.mocked(call).mockClear();
  await transport.open(request);
  await transport.input('x', 'ls');
  await transport.ack('x', 3);
  await transport.resize?.('x', 100, 30);
  await transport.close('x');
  return vi.mocked(call).mock.calls;
}

describe('terminal transports', () => {
  beforeEach(() => vi.mocked(call).mockClear());

  it('opens a saved SSH connection through connect and the terminal commands', async () => {
    expect(await commands(remoteTransport(ssh))).toEqual([
      [
        'connect',
        {
          id: 'x',
          profileId: 'p1',
          expected: ssh,
          secret: 's',
          remember: true,
          launch: undefined,
          onEvent,
        },
      ],
      ['terminal_input', { id: 'x', data: 'ls' }],
      ['terminal_ack', { id: 'x', seq: 3 }],
      ['terminal_resize', { id: 'x', cols: 100, rows: 30 }],
      ['disconnect', { id: 'x' }],
    ]);
  });

  it('sends no size for FTP, which has no shell', async () => {
    const transport = remoteTransport(ftp);
    expect(transport.resize).toBeUndefined();
    expect((await commands(transport)).map(([name]) => name)).toEqual([
      'connect',
      'terminal_input',
      'terminal_ack',
      'disconnect',
    ]);
  });

  it('opens Telnet through connect and sends its size, with nothing typed for the app', async () => {
    const transport = remoteTransport({ protocol: 'telnet' });
    expect(transport.kind).toBe('telnet');
    expect((await commands(transport)).map(([name]) => name)).toEqual([
      'connect',
      'terminal_input',
      'terminal_ack',
      'terminal_resize',
      'disconnect',
    ]);
    expect([transport.typedHook, transport.gitCredentials, transport.programGuide]).toEqual([
      false,
      false,
      false,
    ]);
    expect([transport.directory, transport.agent, transport.links]).toEqual(['none', false, null]);
  });

  it('opens a serial console through connect, with no window size to send', async () => {
    const transport = remoteTransport({ protocol: 'serial' });
    expect(transport.kind).toBe('serial');
    expect(transport.resize).toBeUndefined();
    expect((await commands(transport)).map(([name]) => name)).toEqual([
      'connect',
      'terminal_input',
      'terminal_ack',
      'disconnect',
    ]);
  });

  it("runs this computer's shell through the local commands", async () => {
    expect(await commands(localTransport(shell))).toEqual([
      ['local_open', { id: 'x', targetId: 'pwsh', cols: 80, rows: 24, onEvent }],
      ['local_input', { id: 'x', data: 'ls' }],
      ['local_ack', { id: 'x', seq: 3 }],
      ['local_resize', { id: 'x', cols: 100, rows: 30 }],
      ['local_close', { id: 'x' }],
    ]);
  });

  it('runs a pod command through the kube terminal commands', async () => {
    expect(await commands(podTransport(launch))).toEqual([
      ['kube_terminal_open', { id: 'x', launch, cols: 80, rows: 24, onEvent }],
      ['kube_terminal_input', { id: 'x', data: 'ls' }],
      ['kube_terminal_ack', { id: 'x', seq: 3 }],
      ['kube_terminal_resize', { id: 'x', cols: 100, rows: 30 }],
      ['kube_terminal_close', { id: 'x' }],
    ]);
  });

  it('keeps what each tab supported before transports', () => {
    const row = (t: TerminalTransport) => [
      t.kind,
      t.directory,
      t.typedHook,
      t.gitCredentials,
      t.programGuide,
      t.windowsPaths,
      t.agent,
      t.links,
    ];
    expect(
      [
        remoteTransport(ssh),
        remoteTransport(ftp),
        localTransport(shell),
        localTransport(wsl),
        podTransport(launch),
      ].map(row),
    ).toEqual([
      ['ssh', 'remote', true, true, true, false, true, 'remote'],
      ['ftp', 'none', true, true, true, false, false, null],
      ['local', 'launch', false, false, true, true, true, 'local'],
      ['local', 'typed', true, false, true, false, true, 'local'],
      ['pod', 'none', false, false, false, false, false, null],
    ]);
  });

  it('carries the target only on its own kind', () => {
    expect(localTransport(wsl).localTarget).toBe(wsl);
    expect(podTransport(launch).podLaunch).toBe(launch);
    expect(remoteTransport(ssh)).not.toHaveProperty('localTarget');
    expect(remoteTransport(ssh)).not.toHaveProperty('podLaunch');
  });

  it('follows an edited protocol on reconnect, and keeps local and pod targets', () => {
    expect(remoteTransport(ssh).reopen(ftp).kind).toBe('ftp');
    expect(remoteTransport(ftp).reopen(ssh).kind).toBe('ssh');
    const local = localTransport(shell);
    expect(local.reopen(ssh)).toBe(local);
    const pod = podTransport(launch);
    expect(pod.reopen(ssh)).toBe(pod);
  });
});
