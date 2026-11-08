import type { GitConfigTarget } from '../features/settings/gitConfigModel';
import type { LocalCatalog } from '../features/terminal/sessionTypes';
import type { SettingsRepo } from '../lib/settingsRequest';
import type { Source } from '../lib/source';

export const repoTargetId = 'repo';

/** The selected tab's server, while that tab is connected over SSH. */
export type GitConfigServer = { source: Source; name: string };

/**
 * What the Git settings can edit: this PC, each WSL distribution and the selected tab's server,
 * and with a repository from the Git view, that repository's own settings first.
 */
export function gitConfigTargets(
  catalog: LocalCatalog | null,
  server: GitConfigServer | null,
  repo: SettingsRepo | undefined,
): GitConfigTarget[] {
  const global = { kind: 'global' } as const;
  const targets: GitConfigTarget[] = [];
  if (repo)
    targets.push({
      id: repoTargetId,
      label: `이 저장소 · ${repo.folder}`,
      source: repo.source,
      scope: { kind: 'local', folder: repo.folder },
    });
  // Any shell of this PC runs the same git, so the first one stands for them all.
  const shell = catalog?.targets.find((target) => target.kind !== 'wsl');
  if (shell)
    targets.push({
      id: 'this-pc',
      label: '이 PC',
      source: { kind: 'local', targetId: shell.id },
      scope: global,
    });
  for (const target of catalog?.targets ?? [])
    if (target.kind === 'wsl')
      targets.push({
        id: target.id,
        label: `WSL · ${target.name}`,
        source: { kind: 'local', targetId: target.id },
        scope: global,
      });
  if (server)
    targets.push({
      id: 'server',
      label: `서버 · ${server.name}`,
      source: server.source,
      scope: global,
    });
  return targets;
}
