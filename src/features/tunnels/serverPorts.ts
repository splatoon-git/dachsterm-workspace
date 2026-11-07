/** Rules for opening a server's own port on this PC through a temporary tunnel. */
import { call } from '../../lib/ipc';

export type ServerPort = { port: number; host: string };
export type TunnelStatus = {
  id: string;
  connectionId: string;
  name: string;
  kind: string;
  port: number;
  host: string;
  targetPort: number;
  status: string;
  message: string;
};
export type Target = { host: string; port: number };

const portAttempts = 10;
const systemPortLimit = 1024;

export const isTemporaryTunnel = (status: TunnelStatus) =>
  status.id.startsWith(`${status.connectionId}:temp-`);

/** Where to connect on the server. A wildcard listen address is not a destination. */
export function connectHost(listening: string) {
  if (listening === '0.0.0.0') return '127.0.0.1';
  return listening === '::' ? 'localhost' : listening;
}

export function visiblePorts(ports: ServerPort[], showSystem: boolean) {
  return showSystem ? ports : ports.filter((p) => p.port >= systemPortLimit);
}

export function linkTarget(url: string): Target | null {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    return { host: connectHost(parsed.hostname.replace(/^\[|\]$/g, '')), port };
  } catch {
    return null;
  }
}

/** Only the address and port change, so the page, query and scheme stay as the server printed. */
export function browserUrl(link: string | undefined, localPort: number) {
  const url = new URL(link ?? 'http://127.0.0.1/');
  url.hostname = '127.0.0.1';
  url.port = String(localPort);
  return url.toString();
}

export const runningTemporary = (statuses: TunnelStatus[], connectionId: string) =>
  statuses.filter(
    (s) => s.connectionId === connectionId && s.status === 'running' && isTemporaryTunnel(s),
  );

/**
 * Starts from the server's port number and tries the next ones if this PC already uses it. Never
 * saved, so it disappears with the connection. An unchanged target reuses the running tunnel.
 */
export async function openTemporaryTunnel(
  connectionId: string,
  profileId: string,
  target: Target,
  invoke: typeof call = call,
) {
  const running = runningTemporary(await invoke<TunnelStatus[]>('tunnel_list'), connectionId).find(
    (s) => s.host === target.host && s.targetPort === target.port,
  );
  if (running) return running.port;
  const id = `temp-${crypto.randomUUID()}`;
  let failure: unknown = '내 PC에서 쓸 수 있는 포트를 찾지 못했습니다.';
  for (let attempt = 0; attempt < portAttempts; attempt++) {
    const port = target.port + attempt;
    if (port > 65535) break;
    const config = {
      id,
      profileId,
      name: `서버 포트 ${target.port}`,
      kind: 'local',
      port,
      host: target.host,
      targetPort: target.port,
      autoStart: false,
    };
    try {
      await invoke('tunnel_start', { id: connectionId, config });
      const started = (await invoke<TunnelStatus[]>('tunnel_list')).find(
        (s) => s.id === `${connectionId}:${id}` && s.status === 'running',
      );
      if (started) return started.port;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
