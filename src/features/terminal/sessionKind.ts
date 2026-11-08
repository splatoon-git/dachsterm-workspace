import type { Profile } from '../../lib/ipc';
import type { Source } from '../../lib/source';
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
  /** The Kubernetes workspace can run over this connection. */
  kube: boolean;
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
  ssh: {
    terminal: true,
    log: true,
    guide: true,
    split: true,
    detach: true,
    monitor: true,
    kube: true,
  },
  local: {
    terminal: true,
    log: true,
    guide: true,
    split: true,
    detach: false,
    monitor: false,
    kube: false,
  },
  podtree: {
    terminal: true,
    log: false,
    guide: false,
    split: false,
    detach: false,
    monitor: false,
    kube: false,
  },
  ftp: {
    terminal: false,
    log: false,
    guide: false,
    split: false,
    detach: false,
    monitor: false,
    kube: false,
  },
};

export const capabilities = (session: SessionLike) => table[sessionKind(session)];

/** What commands that work on any tab are told about this one. PodTree has no files of its own. */
export function sessionSource(session: SessionLike & { connectionId: string }): Source | null {
  if (session.podtree) return null;
  if (session.localTarget) return { kind: 'local', targetId: session.localTarget.id };
  return {
    kind: session.profile.protocol === 'ssh' ? 'ssh' : 'ftp',
    connectionId: session.connectionId,
  };
}
