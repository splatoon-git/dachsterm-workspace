import { Channel } from '@tauri-apps/api/core';
import { call, type Profile } from '../../lib/ipc';
import { LoginLink, type LinkState } from '../../lib/loginLink';

export { applyLinkEvent, noLink, type LinkEvent, type LinkState } from '../../lib/loginLink';
export type SourceMode = 'local' | 'remote';
/** Where a network tool runs from. */
export type Source = { kind: 'local' } | { kind: 'remote'; connectionId: string };

/** Null while a remote source is still connecting or has ended. */
export function sourceOf(mode: SourceMode, link: LinkState): Source | null {
  if (mode === 'local') return { kind: 'local' };
  return link.id && link.status === 'connected' ? { kind: 'remote', connectionId: link.id } : null;
}

export function filterSessions(profiles: Profile[], query: string) {
  const text = query.trim().toLowerCase();
  return profiles.filter(
    (p) =>
      p.protocol === 'ssh' &&
      (!text || `${p.name} ${p.host} ${p.username}`.toLowerCase().includes(text)),
  );
}

/** The remote source of one tool tab. The tab owns it, and letting go closes what it opened. */
export class SourceLink extends LoginLink {
  constructor() {
    super({
      connect: 'net_connect',
      disconnect: 'net_disconnect',
      connecting: '출발지에 연결하는 중…',
    });
  }
  override async open(profile: Profile) {
    const { id: current, profile: chosen, status } = this.state;
    if (current && chosen?.id === profile.id && status === 'connected') {
      // Choosing it again is a use. The backend only restarts the idle clock and sends nothing.
      await call('net_connect', {
        id: current,
        profileId: profile.id,
        onEvent: new Channel(),
      }).catch((e) => this.report(current, e));
      return;
    }
    return super.open(profile);
  }
}
