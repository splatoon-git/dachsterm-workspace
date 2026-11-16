import { describe, expect, it } from 'vitest';
import { blankProfile, type NetworkProxy } from '../../lib/ipc';
import { proxySecretArgs, withProxyKind } from './proxy';

const http: NetworkProxy = { kind: 'http', host: 'proxy', port: 3128, username: 'user' };

describe('session proxy form', () => {
  it('starts each kind on its usual port and keeps a port the user typed', () => {
    expect(withProxyKind(null, 'socks5')).toEqual({
      kind: 'socks5',
      host: '',
      port: 1080,
      username: '',
    });
    expect(withProxyKind(http, 'socks5')).toEqual({ ...http, kind: 'socks5', port: 1080 });
    expect(withProxyKind({ ...http, port: 8080 }, 'socks5')).toMatchObject({ port: 8080 });
    expect(withProxyKind(http, '')).toBeNull();
    expect(withProxyKind(http, 'command')).toEqual({ kind: 'command', command: '' });
    const command = { kind: 'command', command: 'nc %h %p' } as const;
    expect(withProxyKind(command, 'command')).toBe(command);
    expect(withProxyKind(command, 'http')?.kind).toBe('http');
  });
  it('sends a password only for a named account and only when one was typed', () => {
    const profile = { ...blankProfile(), proxy: http };
    expect(proxySecretArgs(profile, { action: 'replace', value: 'pw' })).toEqual({
      proxySecretAction: 'replace',
      proxySecret: 'pw',
    });
    expect(proxySecretArgs(profile, { action: 'replace', value: '' })).toEqual({
      proxySecretAction: 'keep',
      proxySecret: null,
    });
    expect(proxySecretArgs(profile, { action: 'forget', value: 'pw' })).toEqual({
      proxySecretAction: 'forget',
      proxySecret: null,
    });
    const anonymous = { ...profile, proxy: { ...http, username: '' } };
    expect(proxySecretArgs(anonymous, { action: 'replace', value: 'pw' }).proxySecretAction).toBe(
      'keep',
    );
    const command = { ...profile, proxy: { kind: 'command' as const, command: 'nc %h %p' } };
    expect(proxySecretArgs(command, { action: 'replace', value: 'pw' }).proxySecretAction).toBe(
      'keep',
    );
    expect(proxySecretArgs(blankProfile(), { action: 'forget', value: '' })).toEqual({
      proxySecretAction: 'keep',
      proxySecret: null,
    });
  });
});
