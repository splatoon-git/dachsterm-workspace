// @vitest-environment jsdom
import { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachTerminalIntegrations } from './integrations';
import { KittyKeyboard } from './kittyKeyboard';
import { saveTerminalPreferences } from './preferences';
import { ProgramStatus } from './programStatus';

// jsdom has no canvas and reports that on stderr. These tests never draw.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

function setup(withAgent = true) {
  const terminal = new Terminal({ allowProposedApi: false });
  const keyboard = new KittyKeyboard();
  const status = new ProgramStatus();
  const copy = vi.fn();
  const attention = vi.fn();
  const replay = { active: false };
  const host = {
    windowsPaths: false,
    directory: vi.fn(),
    program: vi.fn(),
    respond: vi.fn(),
    agent: withAgent
      ? { keyboard, status, replaying: () => replay.active, copy, attention, tmuxMissing: vi.fn() }
      : undefined,
  };
  attachTerminalIntegrations(terminal, host);
  const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
  return { terminal, keyboard, status, host, write, copy, replay, attention };
}

describe('terminal integrations', () => {
  it('answers the keyboard query and follows push and pop', async () => {
    const { keyboard, host, write } = setup();
    await write('\x1b[?u');
    expect(host.respond).toHaveBeenCalledWith('\x1b[?0u');
    await write('\x1b[>5u');
    expect(keyboard.flags('normal')).toBe(1);
    await write('\x1b[<u');
    expect(keyboard.flags('normal')).toBe(0);
  });

  it('reads both parameters of the set form', async () => {
    const { keyboard, write } = setup();
    await write('\x1b[=1;2u');
    expect(keyboard.flags('normal')).toBe(1);
    await write('\x1b[=1;3u');
    expect(keyboard.flags('normal')).toBe(0);
  });

  it('follows modifyOtherKeys requests and their reset', async () => {
    const { keyboard, write } = setup();
    await write('\x1b[>4;1m');
    expect(keyboard.otherKeys).toBe(1);
    await write('\x1b[>4m');
    expect(keyboard.otherKeys).toBe(0);
    await write('\x1b[>4;2m\x1bc');
    expect(keyboard.otherKeys).toBe(0);
    await write('\x1b[>1;2m');
    expect(keyboard.otherKeys).toBe(0);
  });

  it('tracks the alternate screen separately', async () => {
    const { keyboard, write } = setup();
    await write('\x1b[?1049h\x1b[>1u');
    expect(keyboard.flags('alternate')).toBe(1);
    expect(keyboard.flags('normal')).toBe(0);
  });

  it('clears the keyboard on a full reset and still lets xterm reset itself', async () => {
    const { terminal, keyboard, write } = setup();
    await write('\x1b[>1u\x1b[?1049h');
    expect(terminal.buffer.active.type).toBe('alternate');
    await write('\x1bc');
    expect(keyboard.flags('normal')).toBe(0);
    expect(terminal.buffer.active.type).toBe('normal');
  });

  it('takes status from a hook in tmux, with only the four allowed words', async () => {
    const { status, write } = setup();
    await write('\x1b]777;DachsTerm;status;working\x07');
    expect(status.snapshot()?.state).toBe('working');
    await write('\x1b]777;DachsTerm;status;blocked\x07');
    expect(status.snapshot()?.state).toBe('blocked');
    await write('\x1b]777;DachsTerm;status;done\x07');
    expect(status.snapshot()?.state).toBe('done');
    await write('\x1b]777;DachsTerm;status;error\x07');
    expect(status.snapshot()?.state).toBe('error');
    await write('\x1b]777;DachsTerm;status;clear\x07');
    await write('\x1b]777;DachsTerm;status;working;x\x07');
    await write('\x1b]777;DachsTerm;status;\x07');
    expect(status.snapshot()?.state).toBe('error');
  });

  it('ignores a hook status while the setting is off', async () => {
    const { status, write } = setup();
    saveTerminalPreferences({ programStatus: false });
    await write('\x1b]777;DachsTerm;status;working\x07');
    expect(status.snapshot()).toBeNull();
    saveTerminalPreferences({ programStatus: true });
  });

  it('reports a server without tmux', async () => {
    const { host, write } = setup();
    await write('\x1b]777;DachsTerm;tmux;missing\x07');
    expect(host.agent?.tmuxMissing).toHaveBeenCalledOnce();
  });

  it('does not answer on tabs without agent signals', async () => {
    const { host, write } = setup(false);
    await write('\x1b[?u\x1b]7501;?\x07');
    expect(host.respond).not.toHaveBeenCalled();
  });

  it('answers the status query with nothing from any report', async () => {
    const { status, host, write } = setup();
    await write('\x1b]7501;state=working:app=secret\x1b\\\x1b]7501;?\x1b\\');
    expect(status.snapshot()?.state).toBe('working');
    expect(host.respond).toHaveBeenCalledExactlyOnceWith('\x1b]7501;?\x1b\\');
  });

  it('accepts both string terminators for reports', async () => {
    const { status, write } = setup();
    await write('\x1b]7501;state=done\x07');
    expect(status.snapshot()?.state).toBe('done');
    await write('\x1b]7501;state=error\x1b\\');
    expect(status.snapshot()?.state).toBe('error');
  });

  it('treats a shell prompt as the end of the running program', async () => {
    const { status, write, host } = setup();
    await write('\x1b]7501;state=working\x07\x1b]133;A\x07');
    expect(status.snapshot()).toBeNull();
    await write('\x1b]7501;state=blocked\x07\x1b]1337;CurrentDir=/srv\x07');
    expect(status.snapshot()).toBeNull();
    expect(host.directory).toHaveBeenCalledWith('/srv');
    await write('\x1b]7501;state=done\x07\x1b]133;A\x07');
    expect(status.snapshot()?.state).toBe('done');
  });

  it('removes every record on a full reset', async () => {
    const { status, write } = setup();
    await write('\x1b]7501;state=blocked\x07\x1bc');
    expect(status.snapshot()).toBeNull();
  });

  describe('attention', () => {
    it('reports status changes that need the user, once each', async () => {
      const { attention, write } = setup();
      await write('\x1b]7501;state=working\x07');
      expect(attention).not.toHaveBeenCalled();
      await write(`\x1b]7501;state=blocked:msg=${btoa('why')}\x07`);
      expect(attention).toHaveBeenCalledExactlyOnceWith('blocked', 'why');
      await write(`\x1b]7501;state=blocked:msg=${btoa('why')}\x07`);
      expect(attention).toHaveBeenCalledTimes(1);
      await write('\x1b]7501;state=done\x07');
      expect(attention).toHaveBeenLastCalledWith('done', '');
    });

    it('takes the bell and the notification sequences measured from real programs', async () => {
      const { attention, write } = setup();
      await write('\x07');
      expect(attention).toHaveBeenLastCalledWith('bell');
      await write('\x1b]9;needs you\x07');
      expect(attention).toHaveBeenLastCalledWith('message', 'needs you');
      await write('\x1b]777;notify;Title;needs you\x07');
      expect(attention).toHaveBeenLastCalledWith('message', 'Title · needs you');
    });

    it('does not treat progress as a notification', async () => {
      const { attention, write } = setup();
      await write('\x1b]9;4;1;50\x07');
      expect(attention).not.toHaveBeenCalled();
    });

    it('stays silent on tabs without agent signals', async () => {
      const { attention, write } = setup(false);
      await write('\x07\x1b]777;notify;a;b\x07');
      expect(attention).not.toHaveBeenCalled();
    });
  });

  describe('OSC 52 writes', () => {
    const osc = `\x1b]52;c;${btoa('copied')}\x07`;
    function focusedSetup() {
      const context = setup();
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      Object.defineProperty(document, 'activeElement', {
        configurable: true,
        // The terminal is never opened here, so it has no textarea: both sides are undefined.
        get: () => context.terminal.textarea,
      });
      return context;
    }
    afterEach(() => {
      vi.restoreAllMocks();
      Reflect.deleteProperty(document, 'activeElement');
    });

    it('copies from the pane the user is in', async () => {
      const { copy, write } = focusedSetup();
      await write(osc);
      expect(copy).toHaveBeenCalledExactlyOnceWith('copied');
    });

    it('ignores a replayed copy', async () => {
      const { copy, replay, write } = focusedSetup();
      replay.active = true;
      await write(osc);
      expect(copy).not.toHaveBeenCalled();
    });

    it('ignores a copy from a window without focus', async () => {
      const { copy, write } = focusedSetup();
      vi.spyOn(document, 'hasFocus').mockReturnValue(false);
      await write(osc);
      expect(copy).not.toHaveBeenCalled();
    });

    it('honours the setting and never answers a read', async () => {
      const { copy, host, write } = focusedSetup();
      await write('\x1b]52;c;?\x07');
      expect(host.respond).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      saveTerminalPreferences({ clipboardWrite: false });
      try {
        await write(osc);
        expect(copy).not.toHaveBeenCalled();
      } finally {
        saveTerminalPreferences({ clipboardWrite: true });
      }
    });
  });

  it('does nothing when the setting is off', async () => {
    const { status, host, write } = setup();
    saveTerminalPreferences({ programStatus: false });
    try {
      await write('\x1b]7501;?\x07\x1b]7501;state=working\x07');
      expect(host.respond).not.toHaveBeenCalled();
      expect(status.snapshot()).toBeNull();
    } finally {
      saveTerminalPreferences({ programStatus: true });
    }
  });

  it('reports directories and guide programs, and passes other sequences on', async () => {
    const { host, write } = setup();
    await write('\x1b]1337;CurrentDir=/srv/app\x07');
    expect(host.directory).toHaveBeenCalledWith('/srv/app');
    await write('\x1b]7;file://host/tmp/a%20b\x07');
    expect(host.directory).toHaveBeenCalledWith('/tmp/a b');
    await write('\x1b]777;DachsTerm;program;vim\x07');
    expect(host.program).toHaveBeenCalledWith('vim');
    await write('\x1b]777;DachsTerm;end\x07');
    expect(host.program).toHaveBeenLastCalledWith(null);
    host.program.mockClear();
    await write('\x1b]777;notify;a;b\x07');
    expect(host.program).not.toHaveBeenCalled();
  });
});
