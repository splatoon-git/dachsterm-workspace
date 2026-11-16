import type { Channel } from '@tauri-apps/api/core';
import { call, type PodTerminalLaunch, type Profile, type TerminalLaunch } from '../../lib/ipc';
import type { DirectoryHookMode } from './directoryHook';
import type { SessionKind } from './sessionKind';
import type { LocalTarget, SessionEvent } from './sessionTypes';

/** What opening a connection is given. Each transport takes the fields it needs. */
export type OpenRequest = {
  id: string;
  profile: Profile;
  secret: string | null;
  remember: boolean;
  launch?: TerminalLaunch;
  cols: number;
  rows: number;
  onEvent: Channel<SessionEvent>;
};

/**
 * How a terminal tab reaches its shell, and what that shell supports. `TerminalSession` only asks
 * this object, so a new kind of terminal (Telnet, a serial port) is a new transport, not new
 * branches in the session. The backend side keeps its own rules: see `ssh.rs`, `local.rs` and
 * `kube/terminal.rs` before changing ACK or input limits.
 */
export type TerminalTransport = {
  readonly kind: SessionKind;
  /** This computer's shell the tab runs. Only a local tab has one. */
  readonly localTarget?: LocalTarget;
  /** The pod command the tab runs. Only a pod tab has one. */
  readonly podLaunch?: PodTerminalLaunch;
  /**
   * Where the tab's folder is reported from, before the profile's own limits (tmux, the
   * Kubernetes workspace). `remote`: the hook typed into the server's shell.
   */
  readonly directory: DirectoryHookMode;
  /** The Bash/Zsh hook can be typed by hand when it is not installed. */
  readonly typedHook: boolean;
  /** Asks the backend for the HTTPS Git helper line typed with the hook (DX.12). */
  readonly gitCredentials: boolean;
  /** Program guides follow what runs. A pod tab runs one fixed command. */
  readonly programGuide: boolean;
  /** Output may show Windows paths, which become links. */
  readonly windowsPaths: boolean;
  /** Agent marks, signing and tmux notices from programs in this shell. */
  readonly agent: boolean;
  /** Addresses in the output become links, opened on the server or on this computer. */
  readonly links: 'remote' | 'local' | null;
  open(request: OpenRequest): Promise<unknown>;
  input(id: string, data: string): Promise<unknown>;
  ack(id: string, seq: number): Promise<unknown>;
  /** Absent when the far end has no terminal size to set. */
  resize?(id: string, cols: number, rows: number): Promise<unknown>;
  close(id: string): Promise<unknown>;
  /** The transport a reconnect with this saved profile uses. */
  reopen(profile: Profile): TerminalTransport;
};

const sshCommands = {
  open: ({ id, profile, secret, remember, launch, onEvent }: OpenRequest) =>
    call('connect', {
      id,
      profileId: profile.id,
      expected: profile,
      secret,
      remember,
      launch,
      onEvent,
    }),
  input: (id: string, data: string) => call('terminal_input', { id, data }),
  ack: (id: string, seq: number) => call('terminal_ack', { id, seq }),
  close: (id: string) => call('disconnect', { id }),
  reopen: (profile: Profile) => remoteTransport(profile),
};

/**
 * A saved connection. FTP and FTPS tabs also open through `connect`, but have no shell: the size,
 * the hook and program helpers apply to SSH only. Telnet has a terminal and nothing else.
 */
export function remoteTransport(profile: Pick<Profile, 'protocol'>): TerminalTransport {
  if (profile.protocol === 'telnet') return telnetTransport;
  if (profile.protocol === 'serial') return serialTransport;
  if (profile.protocol !== 'ssh')
    return {
      ...sshCommands,
      kind: 'ftp',
      directory: 'none',
      typedHook: true,
      gitCredentials: true,
      programGuide: true,
      windowsPaths: false,
      agent: false,
      links: null,
    };
  return {
    ...sshCommands,
    kind: 'ssh',
    directory: 'remote',
    typedHook: true,
    gitCredentials: true,
    programGuide: true,
    windowsPaths: false,
    agent: true,
    links: 'remote',
    resize: (id, cols, rows) => call('terminal_resize', { id, cols, rows }),
  };
}

/**
 * A Telnet device or host (CG.4). Its shell is unknown and may not be one, so nothing is typed
 * into it for the app: no folder hook, no Git helper, no program guide. Output can still be
 * logged, highlighted and answered by snippets, and the window size goes out by NAWS.
 */
const telnetTransport: TerminalTransport = {
  ...sshCommands,
  kind: 'telnet',
  directory: 'none',
  typedHook: false,
  gitCredentials: false,
  programGuide: false,
  windowsPaths: false,
  agent: false,
  links: null,
  resize: (id, cols, rows) => call('terminal_resize', { id, cols, rows }),
};

/**
 * A device's serial console (CG.5). Like Telnet nothing is typed for the app, and a serial line
 * has no window size to send.
 */
const serialTransport: TerminalTransport = {
  ...telnetTransport,
  kind: 'serial',
  resize: undefined,
};

/** One of this computer's shells. A Windows shell only takes its hook at launch. */
export function localTransport(target: LocalTarget): TerminalTransport {
  const transport: TerminalTransport = {
    kind: 'local',
    localTarget: target,
    directory: target.follow,
    typedHook: target.kind === 'wsl',
    gitCredentials: false,
    programGuide: true,
    windowsPaths: target.kind === 'shell',
    agent: true,
    links: 'local',
    open: ({ id, cols, rows, onEvent }) =>
      call('local_open', { id, targetId: target.id, cols, rows, onEvent }),
    input: (id, data) => call('local_input', { id, data }),
    ack: (id, seq) => call('local_ack', { id, seq }),
    resize: (id, cols, rows) => call('local_resize', { id, cols, rows }),
    close: (id) => call('local_close', { id }),
    reopen: () => transport,
  };
  return transport;
}

/** A shell or log stream in a pod, run through `kubectl` over the connection that opened it. */
export function podTransport(launch: PodTerminalLaunch): TerminalTransport {
  const transport: TerminalTransport = {
    kind: 'pod',
    podLaunch: launch,
    directory: 'none',
    typedHook: false,
    gitCredentials: false,
    programGuide: false,
    windowsPaths: false,
    agent: false,
    links: null,
    open: ({ id, cols, rows, onEvent }) =>
      call('kube_terminal_open', { id, launch, cols, rows, onEvent }),
    input: (id, data) => call('kube_terminal_input', { id, data }),
    ack: (id, seq) => call('kube_terminal_ack', { id, seq }),
    resize: (id, cols, rows) => call('kube_terminal_resize', { id, cols, rows }),
    close: (id) => call('kube_terminal_close', { id }),
    reopen: () => transport,
  };
  return transport;
}
