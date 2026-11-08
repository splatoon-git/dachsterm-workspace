import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blankProfile, type Profile } from '../../lib/ipc';
import {
  applyLinkEvent,
  filterSessions,
  noLink,
  sourceOf,
  SourceLink,
  type LinkEvent,
} from './sourceLink';

const calls = vi.hoisted(() => ({
  log: [] as { command: string; args: Record<string, unknown> }[],
  hold: null as null | (() => void),
}));
vi.mock('../../lib/ipc', async (original) => ({
  ...(await original<typeof import('../../lib/ipc')>()),
  call: async (command: string, args: Record<string, unknown>) => {
    calls.log.push({ command, args });
    if (command === 'net_connect' && calls.hold)
      await new Promise<void>((resolve) => {
        calls.hold = resolve;
      });
  },
}));
vi.mock('@tauri-apps/api/core', async (original) => ({
  ...(await original<typeof import('@tauri-apps/api/core')>()),
  Channel: class {
    onmessage: ((event: LinkEvent) => void) | undefined;
  },
}));

const profile = (over: Partial<Profile> = {}): Profile => ({
  ...blankProfile(),
  id: 'web',
  name: 'web',
  host: '10.0.0.5',
  username: 'deploy',
  ...over,
});
const of = (command: string) => calls.log.filter((c) => c.command === command);
const send = (event: LinkEvent) => {
  const channel = of('net_connect').at(-1)!.args.onEvent as {
    onmessage: (event: LinkEvent) => void;
  };
  channel.onmessage(event);
};
const connected: LinkEvent = { type: 'state', status: 'connected', message: '연결됨' };

beforeEach(() => {
  calls.log.length = 0;
  calls.hold = null;
});

describe('source state', () => {
  it('shows the trust question and clears it when the state moves on', () => {
    const asked = applyLinkEvent(noLink, {
      type: 'hostKey',
      challenge: 'c',
      host: 'h',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:x',
    });
    expect(asked.status).toBe('trust');
    expect(applyLinkEvent(asked, connected).hostKey).toBeNull();
  });

  it('drops an answered login card when the host key question comes', () => {
    const answered = applyLinkEvent(noLink, {
      type: 'authPrompt',
      challenge: 'a',
      name: 'x',
      instructions: '',
      prompts: [],
    });
    const asked = applyLinkEvent(answered, {
      type: 'hostKey',
      challenge: 'c',
      host: 'h',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:x',
    });
    expect(asked.authPrompt).toBeNull();
  });

  it('is usable only when local or connected', () => {
    expect(sourceOf('local', noLink)).toEqual({ kind: 'local' });
    expect(sourceOf('remote', noLink)).toBeNull();
    expect(sourceOf('remote', { ...noLink, id: 'a', status: 'connecting' })).toBeNull();
    expect(sourceOf('remote', { ...noLink, id: 'a', status: 'connected' })).toEqual({
      kind: 'remote',
      connectionId: 'a',
    });
    expect(sourceOf('remote', { ...noLink, id: 'a', status: 'closed' })).toBeNull();
  });

  it('lists SSH sessions only and searches name, address and account', () => {
    const list = [
      profile(),
      profile({ id: 'ftp', name: 'files', protocol: 'ftp' }),
      profile({ id: 'db', name: 'db', host: '10.0.0.9', username: 'root' }),
    ];
    expect(filterSessions(list, '').map((p) => p.id)).toEqual(['web', 'db']);
    expect(filterSessions(list, 'ROOT').map((p) => p.id)).toEqual(['db']);
    expect(filterSessions(list, '10.0.0.5').map((p) => p.id)).toEqual(['web']);
    expect(filterSessions(list, 'files')).toEqual([]);
  });
});

describe('SourceLink', () => {
  it('connects with a new ID and reports the state', async () => {
    const link = new SourceLink();
    await link.open(profile());
    expect(link.snapshot().status).toBe('connecting');
    send(connected);
    expect(link.snapshot().status).toBe('connected');
    expect(of('net_connect')[0].args.id).toBe(link.snapshot().id);
    expect(of('net_connect')[0].args.profileId).toBe('web');
  });

  it('choosing the connected session again keeps the same link', async () => {
    const link = new SourceLink();
    await link.open(profile());
    send(connected);
    const id = link.snapshot().id;
    await link.open(profile());
    expect(of('net_connect')).toHaveLength(2);
    expect(of('net_connect')[1].args.id).toBe(id);
    expect(of('net_disconnect')).toHaveLength(0);
    expect(link.snapshot().status).toBe('connected');
  });

  it('lets go of the old connection when another session is chosen', async () => {
    const link = new SourceLink();
    await link.open(profile());
    send(connected);
    const first = link.snapshot().id;
    await link.open(profile({ id: 'db' }));
    expect(of('net_disconnect')[0].args.id).toBe(first);
    expect(link.snapshot().status).toBe('connecting');
    expect(link.snapshot().id).not.toBe(first);
  });

  it('closes a connection that finishes starting after the tab let go', async () => {
    const link = new SourceLink();
    calls.hold = () => {};
    const opening = link.open(profile());
    await vi.waitFor(() => expect(of('net_connect')).toHaveLength(1));
    const { id } = link.snapshot();
    link.release();
    calls.hold!();
    await opening;
    expect(of('net_disconnect').map((c) => c.args.id)).toEqual([id, id]);
    expect(link.snapshot()).toEqual(noLink);
  });

  it('ignores events from a link it has let go of', async () => {
    const link = new SourceLink();
    await link.open(profile());
    const stale = of('net_connect').at(-1)!.args.onEvent as {
      onmessage: (event: LinkEvent) => void;
    };
    link.release();
    stale.onmessage(connected);
    expect(link.snapshot()).toEqual(noLink);
  });

  it('answers login questions on its own connection', async () => {
    const link = new SourceLink();
    await link.open(profile());
    send({
      type: 'authPrompt',
      challenge: 'c1',
      name: 'x',
      instructions: '',
      prompts: [{ prompt: 'p', echo: false }],
    });
    await link.reply(['answer']);
    expect(of('auth_reply')[0].args).toEqual({
      id: link.snapshot().id,
      challenge: 'c1',
      responses: ['answer'],
    });
  });
});
