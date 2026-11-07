import { describe, expect, it } from 'vitest';
import {
  browserUrl,
  connectHost,
  linkTarget,
  openTemporaryTunnel,
  runningTemporary,
  visiblePorts,
  type TunnelStatus,
} from './serverPorts';

const status = (over: Partial<TunnelStatus>): TunnelStatus => ({
  id: 'conn:temp-1',
  connectionId: 'conn',
  name: 't',
  kind: 'local',
  port: 3000,
  host: '127.0.0.1',
  targetPort: 3000,
  status: 'running',
  message: '',
  ...over,
});

/** A backend where the listed PC ports are already taken. */
function backend(taken: number[], existing: TunnelStatus[] = []) {
  const statuses = [...existing];
  const starts: number[] = [];
  const invoke = (async (command: string, args?: Record<string, never>) => {
    if (command === 'tunnel_list') return statuses;
    const config = (args as unknown as { config: { id: string; port: number; host: string } })
      .config;
    starts.push(config.port);
    if (taken.includes(config.port)) throw '로컬 포트를 열 수 없습니다.';
    statuses.push(status({ id: `conn:${config.id}`, port: config.port, host: config.host }));
    return `conn:${config.id}`;
  }) as never;
  return { invoke, starts };
}

describe('server ports', () => {
  it('connects to a real address when the server listens on all of them', () => {
    expect(connectHost('0.0.0.0')).toBe('127.0.0.1');
    expect(connectHost('::')).toBe('localhost');
    expect(connectHost('127.0.0.1')).toBe('127.0.0.1');
    expect(connectHost('::1')).toBe('::1');
  });

  it('hides system ports unless asked', () => {
    const ports = [
      { port: 22, host: '0.0.0.0' },
      { port: 3000, host: '127.0.0.1' },
    ];
    expect(visiblePorts(ports, false).map((p) => p.port)).toEqual([3000]);
    expect(visiblePorts(ports, true)).toHaveLength(2);
  });

  it('reads the target from a link the server printed', () => {
    expect(linkTarget('http://localhost:5173/app')).toEqual({ host: 'localhost', port: 5173 });
    expect(linkTarget('http://0.0.0.0:8080')).toEqual({ host: '127.0.0.1', port: 8080 });
    expect(linkTarget('http://[::1]:3000/')).toEqual({ host: '::1', port: 3000 });
    expect(linkTarget('https://localhost/')).toEqual({ host: 'localhost', port: 443 });
    expect(linkTarget('http://localhost/')).toEqual({ host: 'localhost', port: 80 });
    expect(linkTarget('not a url')).toBeNull();
  });

  it('changes only the address and port of the link', () => {
    expect(browserUrl('https://localhost:5173/a/b?x=1#y', 5174)).toBe(
      'https://127.0.0.1:5174/a/b?x=1#y',
    );
    expect(browserUrl(undefined, 3000)).toBe('http://127.0.0.1:3000/');
  });

  it('lists only this connection and only running temporary tunnels', () => {
    const list = [
      status({}),
      status({ id: 'other:temp-1', connectionId: 'other' }),
      status({ id: 'conn:saved' }),
      status({ id: 'conn:temp-2', status: 'stopped' }),
    ];
    expect(runningTemporary(list, 'conn').map((s) => s.id)).toEqual(['conn:temp-1']);
  });

  it('uses the same PC port as the server when it is free', async () => {
    const { invoke, starts } = backend([]);
    const target = { host: '127.0.0.1', port: 3000 };
    expect(await openTemporaryTunnel('conn', 'profile', target, invoke)).toBe(3000);
    expect(starts).toEqual([3000]);
  });

  it('moves to the next port when this PC already uses one', async () => {
    const { invoke, starts } = backend([3000, 3001]);
    const target = { host: '127.0.0.1', port: 3000 };
    expect(await openTemporaryTunnel('conn', 'profile', target, invoke)).toBe(3002);
    expect(starts).toEqual([3000, 3001, 3002]);
  });

  it('gives up after ten ports and reports the failure', async () => {
    const taken = Array.from({ length: 20 }, (_, i) => 3000 + i);
    const { invoke, starts } = backend(taken);
    await expect(
      openTemporaryTunnel('conn', 'profile', { host: '127.0.0.1', port: 3000 }, invoke),
    ).rejects.toBe('로컬 포트를 열 수 없습니다.');
    expect(starts).toHaveLength(10);
  });

  it('reuses a running tunnel to the same target and not to another', async () => {
    const running = status({ port: 4000, host: '127.0.0.1', targetPort: 3000 });
    const same = backend([], [running]);
    expect(
      await openTemporaryTunnel('conn', 'p', { host: '127.0.0.1', port: 3000 }, same.invoke),
    ).toBe(4000);
    expect(same.starts).toEqual([]);
    const other = backend([], [running]);
    expect(
      await openTemporaryTunnel('conn', 'p', { host: 'localhost', port: 3000 }, other.invoke),
    ).toBe(3000);
    expect(other.starts).toEqual([3000]);
  });
});
