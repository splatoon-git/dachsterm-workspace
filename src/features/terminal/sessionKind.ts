import type { Profile } from '../../lib/ipc';
import type { LocalTarget, PodTreeLaunch } from './sessionTypes';

export type SessionKind = 'ssh' | 'local' | 'podtree' | 'ftp';
export type SessionCapabilities = {
  /** Has a terminal, so search, copy and paste apply. */
  terminal: boolean;
  /** The output can be recorded to a session log. */
  log: boolean;
  /** Program guides apply; PodTree draws its own screen. */
  guide: boolean;
  /** "Split right/down" can open the same target again. */
  split: boolean;
  /** Can move to a separate window. Only SSH connections can be handed over. */
  detach: boolean;
  /** Server monitoring runs over this connection. */
  monitor: boolean;
};

type SessionLike = {
  profile: Pick<Profile, 'protocol'>;
  localTarget?: LocalTarget;
  podtree?: PodTreeLaunch;
};

export function sessionKind(session: SessionLike): SessionKind {
  if (session.podtree) return 'podtree';
  if (session.localTarget) return 'local';
  return session.profile.protocol === 'ssh' ? 'ssh' : 'ftp';
}

const table: Record<SessionKind, SessionCapabilities> = {
  ssh: { terminal: true, log: true, guide: true, split: true, detach: true, monitor: true },
  local: { terminal: true, log: true, guide: true, split: true, detach: false, monitor: false },
  podtree: {
    terminal: true,
    log: false,
    guide: false,
    split: false,
    detach: false,
    monitor: false,
  },
  ftp: { terminal: false, log: false, guide: false, split: false, detach: false, monitor: false },
};

export const capabilities = (session: SessionLike) => table[sessionKind(session)];
