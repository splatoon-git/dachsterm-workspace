// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blankProfile, type PodTerminalLaunch, type Profile } from '../../lib/ipc';
import { getTheme } from '../../themes/registry';
import { TerminalSession } from './session';
import type { SessionEvent } from './sessionTypes';
import type { OpenRequest, TerminalTransport } from './transport';

vi.mock('@tauri-apps/api/core', async (original) => ({
  ...(await original<typeof import('@tauri-apps/api/core')>()),
  Channel: class {
    onmessage: (event: SessionEvent) => void = () => {};
  },
}));
vi.mock('../../lib/ipc', async (original) => ({
  ...(await original<typeof import('../../lib/ipc')>()),
  call: vi.fn(() => Promise.resolve(null)),
}));

// jsdom has no canvas and reports that on stderr. These tests never draw.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

/**
 * A terminal of a kind the session has no branch for, the way a Telnet or serial transport
 * would be added. It records every call so the session's use of it can be read back.
 */
function fakeTransport(overrides: Partial<TerminalTransport> = {}) {
  const calls: unknown[][] = [];
  const opened: OpenRequest[] = [];
  const transport: TerminalTransport = {
    kind: 'local',
    directory: 'none',
    typedHook: false,
    gitCredentials: false,
    programGuide: true,
    windowsPaths: false,
    agent: false,
    links: null,
    open: async (request) => {
      opened.push(request);
      calls.push(['open', request.id, request.cols, request.rows]);
    },
    input: async (id, data) => void calls.push(['input', id, data]),
    ack: async (id, seq) => void calls.push(['ack', id, seq]),
    resize: async (id, cols, rows) => void calls.push(['resize', id, cols, rows]),
    close: async (id) => void calls.push(['close', id]),
    reopen: () => transport,
    ...overrides,
  };
  return { transport, calls, opened };
}

const profile: Profile = { ...blankProfile(), id: 'p', name: 'serial' };
const sessions: TerminalSession[] = [];
function open(transport: TerminalTransport, onConnected = () => {}) {
  const session = new TerminalSession(profile, getTheme(), onConnected, transport);
  sessions.push(session);
  return session;
}
const emit = (request: OpenRequest, event: SessionEvent) => request.onEvent.onmessage(event);
const connected: SessionEvent = { type: 'state', status: 'connected', message: '연결됨' };

afterEach(() => {
  sessions.splice(0).forEach((session) => session.release());
});

describe('TerminalSession over a transport', () => {
  it('reaches the shell only through its transport', async () => {
    const { transport, calls, opened } = fakeTransport();
    const onConnected = vi.fn();
    const session = open(transport, onConnected);
    expect(session.kind).toBe('local');
    await session.connect('secret', true);
    const id = session.connectionId;
    expect(opened[0]).toMatchObject({ id, profile, secret: 'secret', remember: true });

    emit(opened[0], connected);
    expect(onConnected).toHaveBeenCalledOnce();
    expect(session.snapshot().status).toBe('connected');
    session.send('ls\r');
    emit(opened[0], { type: 'data', seq: 7, bytes: [...new TextEncoder().encode('hi')] });
    await vi.waitFor(() => expect(calls).toContainEqual(['ack', id, 7]));
    await session.disconnect();

    const { cols, rows } = session.terminal;
    expect(calls).toEqual([
      ['open', id, cols, rows],
      ['resize', id, cols, rows],
      ['input', id, 'ls\r'],
      ['ack', id, 7],
      ['close', id],
    ]);
  });

  it('sends no size to a transport without one', async () => {
    const { transport, calls, opened } = fakeTransport({ resize: undefined });
    const session = open(transport);
    await session.connect(null);
    emit(opened[0], connected);
    session.terminal.resize(100, 30);
    expect(calls.map(([name]) => name)).toEqual(['open']);
  });

  it('ignores events from a connection it has left', async () => {
    const { transport, calls, opened } = fakeTransport();
    const session = open(transport);
    await session.connect(null);
    emit(opened[0], { type: 'state', status: 'closed', message: '끊김' });
    await session.reconnect(null, profile);
    emit(opened[0], { type: 'data', seq: 1, bytes: [65] });
    emit(opened[0], connected);
    expect(session.snapshot().status).toBe('connecting');
    expect(calls.filter(([name]) => name === 'ack')).toEqual([]);
  });

  it('reconnects with a new id over the transport the new profile gives', async () => {
    const next = fakeTransport();
    const first = fakeTransport({ reopen: () => next.transport });
    const session = open(first.transport);
    await session.connect(null);
    const before = session.connectionId;
    emit(first.opened[0], { type: 'state', status: 'error', message: '실패' });
    await session.reconnect(null, { ...profile, name: '바뀐 이름' });
    expect(session.connectionId).not.toBe(before);
    expect(next.calls).toEqual([
      ['open', session.connectionId, session.terminal.cols, session.terminal.rows],
    ]);
    expect(session.profile.name).toBe('바뀐 이름');
  });

  it('closes a connection that finishes opening after the tab is gone', async () => {
    let finish = () => {};
    const { transport, calls } = fakeTransport({
      open: () => new Promise<void>((resolve) => (finish = resolve)),
    });
    const session = open(transport);
    const connecting = session.connect(null);
    const id = session.connectionId;
    session.release();
    finish();
    await connecting;
    expect(calls).toEqual([['close', id]]);
  });

  it('asks the transport what the shell supports', () => {
    const plain = open(fakeTransport().transport);
    expect(plain.canTypeDirectoryHook).toBe(false);
    const typed = open(fakeTransport({ typedHook: true }).transport);
    expect(typed.canTypeDirectoryHook).toBe(true);
    typed.profile = { ...profile, tmuxSession: 'main' };
    expect(typed.canTypeDirectoryHook).toBe(false);
  });

  it('points only a pod tab at a new pod', () => {
    const launch = { kind: 'podShell', pod: 'web-2' } as PodTerminalLaunch;
    const local = open(fakeTransport().transport);
    local.retargetPod(launch);
    expect(local.podTerminal).toBeUndefined();
    const pod = open(fakeTransport({ kind: 'pod' }).transport);
    pod.retargetPod(launch);
    expect(pod.podTerminal).toBe(launch);
    expect(pod.kind).toBe('pod');
  });
});
