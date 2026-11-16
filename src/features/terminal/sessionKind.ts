import type { Source } from '../../lib/source';
import type { LocalTarget } from './sessionTypes';

export type SessionKind = 'ssh' | 'local' | 'pod' | 'ftp' | 'telnet';
export type SessionCapabilities = {
  /** Has a terminal, so search, copy and paste apply. */
  terminal: boolean;
  /** The output can be recorded to a session log. */
  log: boolean;
  /** Program guides apply. A pod tab runs one fixed command. */
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

/** A session's kind comes from its transport (`transport.ts`), never from its profile. */
type SessionLike = { kind: SessionKind };

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
  pod: {
    terminal: true,
    log: false,
    guide: false,
    split: false,
    detach: false,
    monitor: false,
    kube: false,
  },
  telnet: {
    terminal: true,
    log: true,
    guide: false,
    split: true,
    detach: true,
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

export const capabilities = (session: SessionLike) => table[session.kind];

/** What commands that work on any tab are told about this one. A pod tab has no files of its own. */
export function sessionSource(
  session: SessionLike & { connectionId: string; localTarget?: Pick<LocalTarget, 'id'> },
): Source | null {
  switch (session.kind) {
    case 'pod':
    case 'telnet':
      return null;
    case 'local':
      return session.localTarget ? { kind: 'local', targetId: session.localTarget.id } : null;
    case 'ssh':
    case 'ftp':
      return { kind: session.kind, connectionId: session.connectionId };
  }
}
