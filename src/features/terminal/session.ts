import { TerminalDecoder } from '../../lib/encoding';
import { directoryFromOsc } from './preferences';
import { programMetadata, type GuideProgram } from './guideData';
import { Channel } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { call, errorText, type Profile } from '../../lib/ipc';
import { terminalTheme } from '../../themes/adapters/xterm';
import type { ThemeDefinition } from '../../themes/contract';
export type PodTreeLaunch = {
  location: { kind: 'ssh' | 'local'; id: string };
  context: string;
  namespace: string;
  operational: boolean;
};
export type LocalTarget = { id: string; name: string; kind: 'shell' | 'wsl' };
export type LocalCatalog = { targets: LocalTarget[]; warning: string | null };
type HostKey = {
  type: 'hostKey';
  challenge: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
};
type Event =
  | { type: 'replay'; active: boolean }
  | AuthPrompt
  | HostKey
  | { type: 'state'; status: string; message: string }
  | { type: 'data'; seq: number; bytes: number[] };
export type AuthPrompt = {
  type: 'authPrompt';
  challenge: string;
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
};
export type SessionState = {
  status: string;
  message: string;
  hostKey: HostKey | null;
  authPrompt?: AuthPrompt | null;
  directory?: string | null;
  guideEnabled?: boolean;
  guideProgram?: GuideProgram | null;
  guideRun?: number;
  replaying?: boolean;
};
export class TerminalSession {
  followDirectory?: boolean;
  setFollowDirectory(value: boolean) {
    this.followDirectory = value;
  }
  readonly tabId = crypto.randomUUID();
  connectionId: string = crypto.randomUUID();
  readonly terminal: Terminal;
  readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  private listeners = new Set<() => void>();
  private current: SessionState = { status: 'connecting', message: '연결 준비 중', hostKey: null };
  private disposed = false;
  private pending = false;
  private inputQueue: string[] = [];
  private sending = false;
  private replaying = false;
  private channel?: Channel<Event>;
  constructor(
    public profile: Profile,
    theme: ThemeDefinition,
    readonly onConnected: () => void,
    readonly localTarget?: LocalTarget,
    readonly podtree?: PodTreeLaunch,
  ) {
    this.terminal = new Terminal({
      theme: terminalTheme(theme),
      fontFamily: theme.foundations.font.mono,
      fontSize: 14,
      scrollback: 5000,
      cursorBlink: true,
      screenReaderMode: true,
      allowProposedApi: false,
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.loadAddon(this.search);
    const directory = (value: string, uri: boolean) => {
      const path = directoryFromOsc(value, uri);
      if (path && !this.localTarget && this.current.directory !== path)
        this.update({ ...this.current, directory: path });
      return true;
    };
    this.terminal.parser.registerOscHandler(7, (value) => directory(value, true));
    this.terminal.parser.registerOscHandler(777, (value) => {
      const program = programMetadata(value);
      if (program === undefined) return false;
      if (this.current.guideEnabled && !this.podtree)
        this.update({
          ...this.current,
          guideProgram: program,
          guideRun: (this.current.guideRun ?? 0) + 1,
        });
      return true;
    });
    this.terminal.parser.registerOscHandler(1337, (value) =>
      value.startsWith('CurrentDir=') ? directory(value.slice(11), false) : false,
    );
    this.terminal.onData((data) => this.send(data));
    this.terminal.onResize(({ cols, rows }) => {
      if (this.current.status === 'connected' && this.profile.protocol === 'ssh')
        void call(
          this.podtree ? 'podtree_resize' : this.localTarget ? 'local_resize' : 'terminal_resize',
          {
            id: this.connectionId,
            cols,
            rows,
          },
        ).catch((e) => this.notice(errorText(e)));
    });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.current;
  enableGuide(enabled: boolean) {
    this.update({ ...this.current, guideEnabled: enabled, guideProgram: null });
  }
  private update(state: SessionState) {
    this.current = state;
    this.listeners.forEach((fn) => fn());
  }
  notice(message: string) {
    this.update({ ...this.current, message });
  }
  applyTheme(theme: ThemeDefinition) {
    this.terminal.options.theme = terminalTheme(theme);
    this.terminal.options.fontFamily = theme.foundations.font.mono;
  }
  configure(fontSize: number, scrollback: number) {
    if (this.terminal.options.fontSize !== fontSize) this.terminal.options.fontSize = fontSize;
    if (this.terminal.options.scrollback !== scrollback)
      this.terminal.options.scrollback = scrollback;
  }
  async connect(secret: string | null, remember = false) {
    if (this.pending || this.disposed) return;
    this.pending = true;
    const id = this.connectionId;
    this.channel = new Channel<Event>();
    this.bindEvents(this.channel, id);
    try {
      await (this.podtree
        ? call('podtree_open', {
            id,
            launch: this.podtree,
            cols: this.terminal.cols,
            rows: this.terminal.rows,
            onEvent: this.channel,
          })
        : this.localTarget
          ? call('local_open', {
              id,
              targetId: this.localTarget.id,
              cols: this.terminal.cols,
              rows: this.terminal.rows,
              onEvent: this.channel,
            })
          : call('connect', {
              id,
              profileId: this.profile.id,
              expected: this.profile,
              secret,
              remember,
              onEvent: this.channel,
            }));
    } catch (e) {
      this.update({ status: 'error', message: errorText(e), hostKey: null });
    } finally {
      this.pending = false;
      if (this.disposed)
        await call(
          this.podtree ? 'podtree_close' : this.localTarget ? 'local_close' : 'disconnect',
          { id },
        ).catch(() => {});
    }
  }
  private bindEvents(channel: Channel<Event>, id: string) {
    const decoder = new TerminalDecoder(this.profile.encoding ?? 'utf-8');
    channel.onmessage = (event) => {
      if (this.disposed || this.connectionId !== id) return;
      if (event.type === 'replay') {
        if (event.active) {
          this.replaying = true;
          this.update({ ...this.current, replaying: true });
        } else {
          // xterm parses asynchronously. Resume input only after the last replay
          // byte, so historical DSR/DA queries cannot write responses to the shell.
          this.terminal.write('', () => {
            if (this.disposed || this.connectionId !== id) return;
            this.replaying = false;
            this.update({ ...this.current, replaying: false });
          });
        }
      } else if (event.type === 'data') {
        const text = decoder.push(event.bytes);
        if (text.includes('\uFFFD'))
          this.notice('일부 문자가 대체 표시되었습니다. 세션 인코딩과 서버 로케일을 확인하세요.');
        this.terminal.write(text, () => {
          void call(
            this.podtree ? 'podtree_ack' : this.localTarget ? 'local_ack' : 'terminal_ack',
            { id, seq: event.seq },
          ).catch(() => {});
        });
      } else if (event.type === 'authPrompt')
        this.update({
          ...this.current,
          authPrompt: event,
          message: '서버의 추가 인증 응답을 입력하세요.',
        });
      else if (event.type === 'hostKey')
        this.update({
          status: 'trust',
          message: '최초 호스트키 확인이 필요합니다.',
          hostKey: event,
        });
      else {
        this.update({
          ...this.current,
          status: event.status,
          message: event.message,
          hostKey: null,
          authPrompt: null,
          guideProgram: null,
        });
        if (event.status === 'connected') {
          if (this.profile.protocol === 'ssh')
            void call(
              this.podtree
                ? 'podtree_resize'
                : this.localTarget
                  ? 'local_resize'
                  : 'terminal_resize',
              {
                id,
                cols: this.terminal.cols,
                rows: this.terminal.rows,
              },
            ).catch((e) => this.notice(errorText(e)));
          this.onConnected();
        }
      }
    };
  }
  async attach(id: string, cols: number, rows: number) {
    this.connectionId = id;
    this.terminal.resize(cols, rows);
    this.channel = new Channel<Event>();
    this.bindEvents(this.channel, id);
    await call('attach_terminal', { id, onEvent: this.channel });
  }
  release() {
    this.disposed = true;
    this.inputQueue = [];
    this.terminal.dispose();
    this.listeners.clear();
  }
  async trust(accept: boolean) {
    try {
      const challenge = this.current.hostKey?.challenge;
      if (!challenge) return;
      await call('trust_host', { id: this.connectionId, accept, challenge });
      if (this.current.hostKey?.challenge === challenge)
        this.update({
          ...this.current,
          hostKey: null,
          message: accept ? '호스트키를 저장하고 있습니다.' : '연결을 취소하고 있습니다.',
        });
    } catch (e) {
      this.notice(errorText(e));
    }
  }
  send(data: string) {
    if (this.current.status !== 'connected' || this.replaying) return;
    // Bound both queued input and individual IPC messages. Preserve surrogate pairs.
    if (this.inputQueue.reduce((n, s) => n + s.length, 0) + data.length > 65536) {
      this.notice('붙여넣기는 한 번에 64KiB 이하로 나누어 주세요.');
      return;
    }
    let chunk = '';
    for (const character of data) {
      chunk += character;
      if (chunk.length >= 4096) {
        this.inputQueue.push(chunk);
        chunk = '';
      }
    }
    if (chunk) this.inputQueue.push(chunk);
    void this.flush();
  }
  private async flush() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.inputQueue.length && !this.disposed)
        await call(
          this.podtree ? 'podtree_input' : this.localTarget ? 'local_input' : 'terminal_input',
          {
            id: this.connectionId,
            data: this.inputQueue.shift()!,
          },
        );
    } catch (e) {
      this.inputQueue = [];
      this.notice(errorText(e));
    } finally {
      this.sending = false;
    }
  }
  async disconnect() {
    await call(this.podtree ? 'podtree_close' : this.localTarget ? 'local_close' : 'disconnect', {
      id: this.connectionId,
    }).catch((e) => this.notice(errorText(e)));
  }
  async reconnect(secret: string | null, profile: Profile, remember = false) {
    if (!['closed', 'error'].includes(this.current.status)) return;
    this.connectionId = crypto.randomUUID();
    this.profile = profile;
    this.inputQueue = [];
    this.terminal.reset();
    this.terminal.writeln('\r\n── 새 연결 · 이전 명령은 재실행하지 않습니다 ──\r\n');
    this.update({ status: 'connecting', message: '재접속 중', hostKey: null });
    await this.connect(secret, remember);
  }
  dispose() {
    this.disposed = true;
    this.inputQueue = [];
    void this.disconnect();
    this.terminal.dispose();
    this.listeners.clear();
  }
}
