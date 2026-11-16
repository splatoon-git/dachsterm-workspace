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
import { AgentSignQueue } from './agentSign';
import { InputQueue } from './inputQueue';
import { Highlighter } from './highlighter';
import { InbandTransfer } from './inbandTransfer';
import type { SessionEvent as Event, SessionState } from './sessionTypes';
export type { LocalCatalog, LocalTarget, SessionState } from './sessionTypes';
import { podTransport, remoteTransport, type TerminalTransport } from './transport';
import { Channel } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import {
  call,
  errorText,
  type PodTerminalLaunch,
  type Profile,
  type TerminalLaunch,
} from '../../lib/ipc';
import {
  terminalColorOptions,
  terminalFontFamily,
  terminalTheme,
} from '../../themes/adapters/xterm';
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
  readonly directoryHookInstaller = new DirectoryHookInstaller({
    terminal: () => this.terminal,
    connected: () => this.current.status === 'connected',
    directory: () => this.current.directory,
    mode: () => {
      // tmux may reattach to a pane where a program runs, so nothing may ever be typed there.
      // A Kubernetes session's shell is hidden, and nothing is typed into a shell nobody sees.
      const { tmuxSession, workspace } = this.profile;
      if (tmuxSession || workspace === 'kubernetes') return 'none';
      return this.transport.directory;
    },
    supportsHook: () =>
      call<boolean>('terminal_supports_directory_hook', { id: this.connectionId }),
    hook: () => shellHook({ guide: terminalPreferences().programGuide, git: this.gitHook }),
    type: (data) => this.send(data),
    write: (data) => this.terminal.write(data),
    report: (status) => this.update({ ...this.current, directoryHook: status }),
  });
  wantsDirectoryFollow() {
    return this.followDirectory ?? terminalPreferences().followDirectory;
  }
  /** The connection's HTTPS Git helper line (DX.12), typed with the hook. */
  private gitHook?: string;
  /** One hook carries folder reports (also used by Git status), program notices and the Git helper. */
  private wantsShellHook() {
    const { programGuide, gitStatus, promptBranch } = terminalPreferences();
    const branch = promptBranch !== 'off';
    return !!this.gitHook || this.wantsDirectoryFollow() || programGuide || gitStatus || branch;
  }
  /** tmux gets the helper from its start command instead, since nothing is typed there. */
  private async loadGitHook(id: string) {
    const { forwardGitCredentials, tmuxSession } = this.profile;
    const asks = forwardGitCredentials && !tmuxSession && this.transport.gitCredentials;
    const hook =
      asks && (await call<string | null>('git_credential_shell', { id }).catch(() => null));
    if (id === this.connectionId) this.gitHook = hook || undefined;
  }
  setFollowDirectory(value: boolean) {
    this.followDirectory = value;
    if (value && this.autoDirectoryHook && this.current.status === 'connected')
      void this.directoryHookInstaller.install();
  }
  /** The typed hook is Bash and Zsh text, and tmux owns the prompt. */
  get canTypeDirectoryHook() {
    return this.transport.typedHook && !this.profile.tmuxSession;
  }
  typeDirectoryHook() {
    this.directoryHookInstaller.cancel();
    this.send(shellHook({ guide: terminalPreferences().programGuide, git: this.gitHook }) + '\r');
    this.terminal.focus();
  }
  readonly tabId = crypto.randomUUID();
  connectionId: string = crypto.randomUUID();
  readonly terminal: Terminal;
  readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  private readonly keyboard = new KittyKeyboard();
  readonly programStatus = new ProgramStatus();
  readonly agentSign = new AgentSignQueue(this);
  readonly view = new PaneView();
  readonly highlighter: Highlighter;
  readonly inband = new InbandTransfer(this);
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
  disposed = false;
  private pending = false;
  private readonly input = new InputQueue({
    send: (data) => this.transport.input(this.connectionId, data),
    notice: (message) => this.notice(message),
    disposed: () => this.disposed,
  });
  private replaying = false;
  private channel?: Channel<Event>;
  private transport: TerminalTransport;
  constructor(
    public profile: Profile,
    theme: ThemeDefinition,
    readonly onConnected: () => void,
    /** How the tab reaches its shell. A saved connection's when absent. */
    transport?: TerminalTransport,
  ) {
    this.transport = transport ?? remoteTransport(profile);
    this.terminal = new Terminal({
      ...terminalColorOptions(theme),
      fontFamily: terminalFontFamily(theme),
      ...terminalDisplay(),
      cursorBlink: true,
      screenReaderMode: true,
      // Decorations, which highlight rules color matches with, are a proposed API in xterm 6.
      allowProposedApi: true,
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.loadAddon(this.search);
    attachTerminalIntegrations(this.terminal, {
      windowsPaths: this.transport.windowsPaths,
      directory: (path) => this.setDirectory(path),
      // Kept while the guide is off too, so turning it on shows a program already running.
      program: (guideProgram) => {
        const guideRun = (this.current.guideRun ?? 0) + 1;
        if (this.transport.programGuide) this.update({ ...this.current, guideProgram, guideRun });
      },
      agent: !this.transport.agent
        ? undefined
        : {
            keyboard: this.keyboard,
            status: this.programStatus,
            replaying: () => this.replaying,
            copy: (text) => this.copyText(text),
            notice: (message) => this.notice(message),
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
    if (this.transport.links)
      attachTerminalLinks(this.terminal, {
        remote: () => this.transport.links === 'remote',
        server: (serverLink) => this.update({ ...this.current, serverLink }),
        notice: (message) => this.notice(message),
      });
    this.highlighter = new Highlighter(
      {
        terminal: this.terminal,
        target: () => ({ profileId: this.profile.id || null, tags: this.profile.tags ?? [] }),
        sessionName: () => this.profile.name,
        connectionId: () => this.connectionId,
        replaying: () => this.replaying,
        notice: (message) => this.notice(message),
        send: (data) => this.send(data),
        paused: (highlightPaused) => this.update({ ...this.current, highlightPaused }),
      },
      theme,
    );
    this.terminal.onData((data) => this.send(data));
    this.terminal.onResize(({ cols, rows }) => {
      if (this.current.status === 'connected') this.resizeRemote(this.connectionId, cols, rows);
    });
  }
  get kind() {
    return this.transport.kind;
  }
  get localTarget() {
    return this.transport.localTarget;
  }
  get podTerminal() {
    return this.transport.podLaunch;
  }
  /** Points a cut pod shell at the workload's new pod before `reconnect`. */
  retargetPod(launch: PodTerminalLaunch) {
    if (this.transport.kind === 'pod') this.transport = podTransport(launch);
  }
  private resizeRemote(id: string, cols: number, rows: number) {
    void this.transport.resize?.(id, cols, rows).catch((e) => this.notice(errorText(e)));
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
    this.terminal.options.fontFamily = terminalFontFamily(theme);
    this.highlighter.setTheme(theme);
  }
  configure(fontSize: number, scrollback: number) {
    if (this.terminal.options.fontSize !== fontSize) this.terminal.options.fontSize = fontSize;
    if (this.terminal.options.scrollback !== scrollback)
      this.terminal.options.scrollback = scrollback;
  }
  async connect(secret: string | null, remember = false, launch?: TerminalLaunch) {
    if (this.pending || this.disposed) return;
    this.pending = true;
    this.autoDirectoryHook = true;
    const id = this.connectionId;
    this.channel = new Channel<Event>();
    this.bindEvents(this.channel, id);
    try {
      await this.transport.open({
        id,
        profile: this.profile,
        secret,
        remember,
        launch,
        cols: this.terminal.cols,
        rows: this.terminal.rows,
        onEvent: this.channel,
      });
    } catch (e) {
      this.update({ status: 'error', message: errorText(e), hostKey: null });
    } finally {
      this.pending = false;
      if (this.disposed) await this.transport.close(id).catch(() => {});
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
        this.highlighter.output(event.bytes.length);
        const text = decoder.push(event.bytes);
        if (text.includes('\uFFFD'))
          this.notice('일부 문자가 대체 표시되었습니다. 세션 인코딩과 서버 로케일을 확인하세요.');
        this.terminal.write(this.directoryHookInstaller.filter.push(text), () => {
          this.directoryHookInstaller.noteOutput();
          void this.transport.ack(id, event.seq).catch(() => {});
        });
      } else if (event.type === 'authPrompt')
        this.update({
          ...this.current,
          authPrompt: event,
          message: '서버의 추가 인증 응답을 입력하세요.',
        });
      else if (event.type === 'agentSign' || event.type === 'gitCredential')
        this.agentSign.add(event, id);
      else if (event.type === 'agentNotice') this.notice(event.message);
      else if (event.type === 'inband') this.inband.update(event);
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
          this.resizeRemote(id, this.terminal.cols, this.terminal.rows);
          this.onConnected();
          void this.loadGitHook(id).then(() => {
            if (this.autoDirectoryHook && this.wantsShellHook())
              void this.directoryHookInstaller.install();
          });
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
    await this.loadGitHook(id);
  }
  release() {
    this.disposed = true;
    this.directoryHookInstaller.cancel();
    this.input.clear();
    this.highlighter.dispose();
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
    this.input.push(data);
  }
  async disconnect() {
    await this.transport.close(this.connectionId).catch((e) => this.notice(errorText(e)));
  }
  async reconnect(secret: string | null, profile: Profile, remember = false) {
    if (!['closed', 'error'].includes(this.current.status)) return;
    this.connectionId = crypto.randomUUID();
    this.profile = profile;
    this.transport = this.transport.reopen(profile);
    this.input.clear();
    this.directoryHookInstaller.cancel();
    this.terminal.reset();
    this.keyboard.reset();
    this.programStatus.reset();
    this.terminal.writeln('\r\n── 새 연결 · 이전 명령은 재실행하지 않습니다 ──\r\n');
    this.update({ status: 'connecting', message: '재접속 중', hostKey: null });
    await this.connect(secret, remember);
  }
  dispose() {
    this.release();
    void this.disconnect();
  }
}
