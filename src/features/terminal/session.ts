import { TerminalDecoder } from '../../lib/encoding';
import { DirectoryHookInstaller } from './directoryHook';
import { terminalDisplay, terminalPreferences } from './preferences';
import { shellHook } from './shellHook';
import { attachTerminalIntegrations } from './integrations';
import { attachTerminalLinks } from './terminalLinks';
import { programNotifier } from './terminalNotify';
import { KittyKeyboard, modifiedEnter } from './kittyKeyboard';
import { ProgramStatus } from './programStatus';
import { PaneView } from './paneView';
import type {
  LocalTarget,
  PodTreeLaunch,
  SessionEvent as Event,
  SessionState,
} from './sessionTypes';
export type {
  AuthPrompt,
  LocalCatalog,
  LocalTarget,
  PodTreeLaunch,
  SessionState,
} from './sessionTypes';
import { Channel } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { call, errorText, type Profile } from '../../lib/ipc';
import { terminalTheme } from '../../themes/adapters/xterm';
import type { ThemeDefinition } from '../../themes/contract';
export class TerminalSession {
  followDirectory?: boolean;
  /** Where the local file panel was, since switching tabs remounts it. */
  private lastFileLocation?: string;
  fileLocation() {
    return this.lastFileLocation;
  }
  rememberFileLocation(path: string) {
    this.lastFileLocation = path;
  }
  private autoDirectoryHook = false;
  private readonly directoryHookInstaller = new DirectoryHookInstaller({
    terminal: () => this.terminal,
    connected: () => this.current.status === 'connected',
    directory: () => this.current.directory,
    mode: () => {
      // tmux may reattach to a pane where a program runs, so nothing may ever be typed there.
      if (this.podtree || this.profile.protocol !== 'ssh' || this.profile.tmuxSession)
        return 'none';
      return this.localTarget?.follow ?? 'remote';
    },
    supportsHook: () =>
      call<boolean>('terminal_supports_directory_hook', { id: this.connectionId }),
    hook: () => shellHook({ guide: terminalPreferences().programGuide }),
    type: (data) => this.send(data),
    write: (data) => this.terminal.write(data),
    report: (status) => this.update({ ...this.current, directoryHook: status }),
  });
  wantsDirectoryFollow() {
    return this.followDirectory ?? terminalPreferences().followDirectory;
  }
  /** One hook carries folder reports and program notices, so either setting installs it. */
  private wantsShellHook() {
    return this.wantsDirectoryFollow() || terminalPreferences().programGuide;
  }
  setFollowDirectory(value: boolean) {
    this.followDirectory = value;
    if (value && this.autoDirectoryHook && this.current.status === 'connected')
      void this.directoryHookInstaller.install();
  }
  /** A Windows shell only takes its hook at launch; the typed hook is Bash and Zsh text. */
  get canTypeDirectoryHook() {
    if (this.podtree || this.profile.tmuxSession) return false;
    return !this.localTarget || this.localTarget.kind === 'wsl';
  }
  typeDirectoryHook() {
    this.directoryHookInstaller.cancel();
    this.send(shellHook({ guide: terminalPreferences().programGuide }) + '\r');
    this.terminal.focus();
  }
  readonly tabId = crypto.randomUUID();
  connectionId: string = crypto.randomUUID();
  readonly terminal: Terminal;
  readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  private readonly keyboard = new KittyKeyboard();
  readonly programStatus = new ProgramStatus();
  readonly view = new PaneView();
  enterSequence(event: KeyboardEvent) {
    const flags = this.keyboard.flags(this.terminal.buffer.active.type);
    return modifiedEnter(event, flags, this.keyboard.otherKeys);
  }
  useOptionAsMeta(value: boolean) {
    this.terminal.options.macOptionIsMeta = value;
  }
  copyText(text: string) {
    void call('clipboard_write_text', { text }).catch((e) => this.notice(errorText(e)));
  }
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
      ...terminalDisplay(),
      cursorBlink: true,
      screenReaderMode: true,
      allowProposedApi: false,
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.loadAddon(this.search);
    attachTerminalIntegrations(this.terminal, {
      windowsPaths: this.localTarget?.kind === 'shell',
      directory: (path) => this.setDirectory(path),
      // Kept while the guide is off too, so turning it on shows a program already running.
      program: (guideProgram) => {
        const guideRun = (this.current.guideRun ?? 0) + 1;
        if (!this.podtree) this.update({ ...this.current, guideProgram, guideRun });
      },
      agent:
        this.podtree || this.profile.protocol !== 'ssh'
          ? undefined
          : {
              keyboard: this.keyboard,
              status: this.programStatus,
              replaying: () => this.replaying,
              copy: (text) => this.copyText(text),
              tmuxMissing: () => this.notice('서버에 tmux가 없어 일반 셸로 시작했습니다.'),
              attention: programNotifier({
                terminal: this.terminal,
                sessionName: () => this.profile.name,
                replaying: () => this.replaying,
                notice: (message) => this.notice(message),
              }),
            },
      respond: (data) => this.send(data),
    });
    if (!this.podtree && this.profile.protocol === 'ssh')
      attachTerminalLinks(this.terminal, {
        remote: () => !this.localTarget,
        server: (serverLink) => this.update({ ...this.current, serverLink }),
        notice: (message) => this.notice(message),
      });
    this.terminal.onData((data) => this.send(data));
    this.terminal.onResize(({ cols, rows }) => {
      if (this.current.status === 'connected' && this.profile.protocol === 'ssh')
        void call(`${this.backend}_resize`, { id: this.connectionId, cols, rows }).catch((e) =>
          this.notice(errorText(e)),
        );
    });
  }
  private get backend() {
    return this.podtree ? 'podtree' : this.localTarget ? 'local' : 'terminal';
  }
  private setDirectory(path: string) {
    if (this.current.directory !== path)
      this.update({ ...this.current, directory: path, directoryHook: undefined });
  }
  /** tmux owns the prompt, so its folder is asked for at moments the user acts, not polled. */
  async syncTmuxDirectory() {
    const id = this.connectionId;
    if (!this.profile.tmuxSession || this.current.status !== 'connected') return;
    if (!this.wantsDirectoryFollow()) return;
    const path = await call<string | null>('tmux_current_path', { id }).catch(() => null);
    if (path && id === this.connectionId) this.setDirectory(path);
  }
  closeServerLink() {
    this.update({ ...this.current, serverLink: undefined });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.current;
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
    this.autoDirectoryHook = true;
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
        this.terminal.write(this.directoryHookInstaller.filter.push(text), () => {
          this.directoryHookInstaller.noteOutput();
          void call(`${this.backend}_ack`, { id, seq: event.seq }).catch(() => {});
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
        if (event.status === 'closed' || event.status === 'error')
          this.programStatus.programEnded();
        if (event.status === 'connected') {
          if (this.profile.protocol === 'ssh')
            void call(`${this.backend}_resize`, {
              id,
              cols: this.terminal.cols,
              rows: this.terminal.rows,
            }).catch((e) => this.notice(errorText(e)));
          this.onConnected();
          if (this.autoDirectoryHook && this.wantsShellHook())
            void this.directoryHookInstaller.install();
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
    this.directoryHookInstaller.cancel();
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
    this.directoryHookInstaller.noteInput();
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
        await call(`${this.backend}_input`, {
          id: this.connectionId,
          data: this.inputQueue.shift()!,
        });
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
    this.directoryHookInstaller.cancel();
    this.terminal.reset();
    this.keyboard.reset();
    this.programStatus.reset();
    this.terminal.writeln('\r\n── 새 연결 · 이전 명령은 재실행하지 않습니다 ──\r\n');
    this.update({ status: 'connecting', message: '재접속 중', hostKey: null });
    await this.connect(secret, remember);
  }
  dispose() {
    this.disposed = true;
    this.directoryHookInstaller.cancel();
    this.inputQueue = [];
    void this.disconnect();
    this.terminal.dispose();
    this.listeners.clear();
  }
}
