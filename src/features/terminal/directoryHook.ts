import type { Terminal } from '@xterm/xterm';

export type DirectoryHookStatus = 'waiting' | 'unavailable';
/** `remote` must pass a login shell check first; `launch` already started with the hook. */
export type DirectoryHookMode = 'remote' | 'typed' | 'launch' | 'none';

const heldOutputLimit = 65536;
const quietBeforeTypingMs = 300;
const quietAfterInputMs = 1000;
const promptWaitMs = 10_000;
const typedConfirmMs = 5_000;
// A first WSL or PowerShell start can take this long before its first prompt.
const launchConfirmMs = 30_000;
const clearCurrentLine = '\r\x1b[2K';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The text before the cursor must end like a prompt, so typed input also rules this out. */
export const atShellPrompt = (beforeCursor: string) => /[$#%>❯➜λ»] ?$/u.test(beforeCursor);

/**
 * Holds output from typing the hook until its marker arrives, so the command echo never reaches
 * the screen. Only a real PTY allows this: ConPTY repaints its own screen, which is why Windows
 * shells receive the hook at launch instead.
 */
export class HookEchoFilter {
  private marker = '';
  private echoStart = '';
  private held = '';
  get active() {
    return this.marker !== '';
  }
  begin(marker: string, echoStart: string) {
    this.marker = marker;
    this.echoStart = echoStart;
    this.held = '';
  }
  push(text: string) {
    if (!this.marker) return text;
    this.held += text;
    const at = this.held.indexOf(this.marker);
    if (at < 0) return this.held.length > heldOutputLimit ? this.flush() : '';
    const rest = this.held.slice(at + this.marker.length);
    const echo = this.held.indexOf(this.echoStart);
    // A command typed just before the hook ran first, and its output must survive. An echo that
    // cannot be located stays visible, because showing the hook is better than losing output.
    const shown =
      echo < 0
        ? this.held.slice(0, at) + rest
        : // The shell reprints its prompt after the hook, in place of the one already on screen.
          this.held.slice(0, echo) + clearCurrentLine + rest;
    this.marker = '';
    this.held = '';
    return shown;
  }
  flush() {
    const held = this.held;
    this.marker = '';
    this.held = '';
    return held;
  }
}

type Host = {
  terminal(): Terminal;
  connected(): boolean;
  directory(): string | null | undefined;
  mode(): DirectoryHookMode;
  supportsHook(): Promise<boolean>;
  /** The hook text, which depends on the settings when it is typed. */
  hook(): string;
  type(data: string): void;
  write(data: string): void;
  report(status: DirectoryHookStatus | undefined): void;
};

/** Connects a shell's directory and program reports without touching its configuration files. */
export class DirectoryHookInstaller {
  readonly filter = new HookEchoFilter();
  private run = 0;
  private lastOutput = 0;
  private lastInput = 0;
  constructor(private readonly host: Host) {}
  noteOutput() {
    this.lastOutput = Date.now();
  }
  noteInput() {
    this.lastInput = Date.now();
  }
  cancel() {
    this.run++;
    this.filter.flush();
  }
  private atPrompt() {
    const terminal = this.host.terminal();
    const buffer = terminal.buffer.active;
    const now = Date.now();
    // Input may not have echoed yet on a slow link, and a program it starts must not get the hook.
    if (
      buffer.type !== 'normal' ||
      now - this.lastOutput < quietBeforeTypingMs ||
      now - this.lastInput < quietAfterInputMs
    )
      return false;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    return atShellPrompt(line?.translateToString(false, 0, buffer.cursorX) ?? '');
  }
  private async typeHook(stale: () => boolean) {
    const mode = this.host.mode();
    if (mode === 'remote' && !(await this.host.supportsHook().catch(() => false))) return false;
    const deadline = Date.now() + promptWaitMs;
    while (!this.atPrompt()) {
      if (stale() || this.host.directory() || Date.now() > deadline) return false;
      await sleep(100);
    }
    if (stale() || this.host.directory()) return false;
    const token = crypto.randomUUID().slice(0, 8);
    const echoStart = `DachsTermHook${token}`;
    this.filter.begin(`\x1b]1337;DachsTermReady=${token}\x07`, echoStart);
    // The leading space keeps it out of history where the shell ignores such lines. The no-op
    // first word marks where the echo starts, since one word is never split by highlighting.
    this.host.type(
      ` : ${echoStart}; ${this.host.hook()}; printf '\\033]1337;DachsTermReady=${token}\\007'\r`,
    );
    return true;
  }
  async install() {
    const run = ++this.run;
    const stale = () => run !== this.run || !this.host.connected();
    const mode = this.host.mode();
    if (this.host.directory()) return;
    if (mode === 'none') return this.host.report('unavailable');
    this.host.report('waiting');
    const launched = mode === 'launch';
    const waiting = launched || (await this.typeHook(stale));
    const deadline = Date.now() + (launched ? launchConfirmMs : typedConfirmMs);
    while (waiting && !stale() && !this.host.directory() && Date.now() < deadline) await sleep(100);
    if (run !== this.run) return;
    if (this.filter.active) this.host.write(this.filter.flush());
    if (!this.host.directory()) this.host.report('unavailable');
  }
}
