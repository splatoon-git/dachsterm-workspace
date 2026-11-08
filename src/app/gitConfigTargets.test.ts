import { describe, expect, it } from 'vitest';
import type { LocalCatalog } from '../features/terminal/sessionTypes';
import { gitConfigTargets, repoTargetId } from './gitConfigTargets';

const catalog: LocalCatalog = {
  targets: [
    { id: 'pwsh', name: 'PowerShell 7', kind: 'shell', follow: 'launch' },
    { id: 'cmd', name: '명령 프롬프트', kind: 'shell', follow: 'launch' },
    { id: 'wsl:Ubuntu', name: 'Ubuntu', kind: 'wsl', follow: 'launch' },
  ],
  warning: null,
};
const server = { source: { kind: 'ssh', connectionId: 'c1' }, name: 'web' } as const;

describe('Git settings targets', () => {
  it('lists this PC once, each WSL distribution and the current server', () => {
    const targets = gitConfigTargets(catalog, server, undefined);
    expect(targets.map((t) => t.label)).toEqual(['이 PC', 'WSL · Ubuntu', '서버 · web']);
    expect(targets[0].source).toEqual({ kind: 'local', targetId: 'pwsh' });
    expect(targets[1].source).toEqual({ kind: 'local', targetId: 'wsl:Ubuntu' });
    expect(targets.every((t) => t.scope.kind === 'global')).toBe(true);
  });

  it('has no server without a connected SSH tab', () => {
    expect(gitConfigTargets(catalog, null, undefined).map((t) => t.id)).toEqual([
      'this-pc',
      'wsl:Ubuntu',
    ]);
  });

  it('puts a repository first, with its own scope and its tab as the source', () => {
    const source = { kind: 'local', targetId: 'wsl:Ubuntu' } as const;
    const [first] = gitConfigTargets(catalog, null, { source, folder: '/srv/app' });
    expect(first).toEqual({
      id: repoTargetId,
      label: '이 저장소 · /srv/app',
      source,
      scope: { kind: 'local', folder: '/srv/app' },
    });
  });

  it('has nothing but a repository while the local list is unknown', () => {
    expect(gitConfigTargets(null, null, undefined)).toEqual([]);
  });
});
