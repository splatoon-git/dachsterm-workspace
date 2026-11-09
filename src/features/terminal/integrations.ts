import type { Terminal } from '@xterm/xterm';
import { programMetadata, type GuideProgram } from './guideData';
import { attachCommandMarks, commandNotice } from './commandMarks';
import type { KittyKeyboard } from './kittyKeyboard';
import { directoryFromOsc, terminalPreferences } from './preferences';
import { parseOsc52 } from './osc52';
import { hookStatus, programStatusQueryReply, type ProgramStatus } from './programStatus';
import { osc777Message, osc9Message, type AttentionReason } from './terminalNotify';

type IntegrationHost = {
  windowsPaths: boolean;
  directory(path: string): void;
  program(program: GuideProgram | null): void;
  /** Absent on tabs that do not take agent signals, such as a pod tab. */
  agent?: {
    keyboard: KittyKeyboard;
    status: ProgramStatus;
    /** A copy made in the past must never replace what is on the clipboard now. */
    replaying(): boolean;
    copy(text: string): void;
    tmuxMissing(): void;
    attention(reason: AttentionReason, detail?: string): void;
  };
  /** Blocked during replay by the session, so old queries are never answered. */
  respond(data: string): void;
};

const firstParam = (params: (number | number[])[], fallback: number) => {
  const value = params[0];
  const number = Array.isArray(value) ? value[0] : value;
  return number === undefined || number === 0 ? fallback : number;
};

/** Registers terminal signal handlers. The terminal's own dispose removes them. */
export function attachTerminalIntegrations(terminal: Terminal, host: IntegrationHost) {
  const { parser } = terminal;
  const agent = host.agent;
  const directory = (value: string, uri: boolean) => {
    const path = directoryFromOsc(value, uri, host.windowsPaths);
    if (path) host.directory(path);
    return true;
  };
  const report = (body: string) => {
    if (!agent || !terminalPreferences().programStatus) return;
    const before = agent.status.snapshot()?.state;
    agent.status.report(body);
    const now = agent.status.snapshot();
    if (now && now.state !== before && now.state !== 'working')
      agent.attention(now.state, now.detail);
  };
  // Long commands notify through the program notifier, which only agent-capable tabs have.
  const marks = attachCommandMarks(terminal, {
    replaying: () => agent?.replaying() ?? false,
    finished: agent && ((exit, ms) => agent.attention('command', commandNotice(exit, ms))),
  });
  parser.registerOscHandler(7, (value) => directory(value, true));
  parser.registerOscHandler(777, (value) => {
    if (marks.reportBranch(value)) return true;
    const program = programMetadata(value);
    if (program !== undefined) {
      host.program(program);
      return true;
    }
    if (value === 'DachsTerm;tmux;missing') {
      agent?.tmuxMissing();
      return true;
    }
    const hook = hookStatus(value);
    if (hook) {
      report(`state=${hook}:id=hook`);
      return true;
    }
    const message = osc777Message(value);
    if (message === null) return false;
    agent?.attention('message', message);
    return true;
  });
  parser.registerOscHandler(1337, (value) => {
    if (!value.startsWith('CurrentDir=')) return false;
    // Our shell hook sends this once per prompt, together with OSC 133;A. Shells without our hook
    // may send neither. OSC 7 is not used for this because programs can send it at any time.
    agent?.status.programEnded();
    return directory(value.slice(11), false);
  });
  if (!agent) return;
  const { keyboard, status } = agent;
  const screen = () => terminal.buffer.active.type;
  parser.registerCsiHandler({ prefix: '?', final: 'u' }, () => {
    host.respond(keyboard.query(screen()));
    return true;
  });
  parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
    keyboard.push(firstParam(params, 0), screen());
    return true;
  });
  parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
    keyboard.pop(firstParam(params, 1), screen());
    return true;
  });
  parser.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => {
    keyboard.set(firstParam(params, 0), firstParam(params.slice(1), 1), screen());
    return true;
  });
  // CSI > 4 ; level m. Other resources of this sequence are not ours to handle.
  parser.registerCsiHandler({ prefix: '>', final: 'm' }, (params) => {
    if (params[0] !== 4) return false;
    keyboard.otherKeys = typeof params[1] === 'number' ? params[1] : 0;
    return true;
  });
  parser.registerOscHandler(7501, (value) => {
    // With the setting off this behaves as an unknown sequence: no reply and no records.
    if (!terminalPreferences().programStatus) return true;
    if (value.trim().startsWith('?')) {
      host.respond(programStatusQueryReply);
      return true;
    }
    report(value);
    return true;
  });
  parser.registerOscHandler(9, (value) => {
    const message = osc9Message(value);
    if (message !== null) agent.attention('message', message);
    return true;
  });
  terminal.onBell(() => agent.attention('bell'));
  parser.registerOscHandler(133, (value) => {
    if (value.startsWith('A')) status.programEnded();
    return false;
  });
  parser.registerOscHandler(52, (value) => {
    // Only the pane the user is in may write, so a background tab cannot replace a copy.
    const focused = document.hasFocus() && document.activeElement === terminal.textarea;
    if (!agent.replaying() && focused && terminalPreferences().clipboardWrite) {
      const text = parseOsc52(value);
      if (text !== null) agent.copy(text);
    }
    return true;
  });
  terminal.onKey(() => status.acknowledge());
  // A full reset must also run xterm's own handling, so this reports the sequence as unhandled.
  parser.registerEscHandler({ final: 'c' }, () => {
    keyboard.reset();
    status.reset();
    return false;
  });
}
