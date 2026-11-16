import type { NetworkProxy, Profile, Proxy } from '../../lib/ipc';

/** What the form does with the proxy password when it saves. */
export type ProxySecret = { action: 'keep' | 'replace' | 'forget'; value: string };

const DEFAULT_PORT: Record<NetworkProxy['kind'], number> = { http: 3128, socks5: 1080 };

/** The proxy after the kind select changes. A default port follows the kind; a typed one stays. */
export function withProxyKind(current: Proxy | null | undefined, kind: string): Proxy | null {
  if (kind === 'command')
    return current?.kind === 'command' ? current : { kind: 'command', command: '' };
  if (kind !== 'http' && kind !== 'socks5') return null;
  if (!current || current.kind === 'command')
    return { kind, host: '', port: DEFAULT_PORT[kind], username: '' };
  const port = Object.values(DEFAULT_PORT).includes(current.port)
    ? DEFAULT_PORT[kind]
    : current.port;
  return { ...current, kind, port };
}

/** The `save_session` arguments for the proxy password. Without a user name there is none. */
export function proxySecretArgs(profile: Profile, secret: ProxySecret) {
  const proxy = profile.proxy;
  const named = !!proxy && proxy.kind !== 'command' && !!proxy.username;
  const action = !named || (secret.action === 'replace' && !secret.value) ? 'keep' : secret.action;
  return {
    proxySecretAction: action,
    proxySecret: action === 'replace' ? secret.value : null,
  };
}
