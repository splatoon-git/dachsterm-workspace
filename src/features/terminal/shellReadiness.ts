import { commandMarksOf } from './commandMarks';
import type { TerminalSession } from './session';

export type TerminalReadiness =
  | { state: 'ready' }
  /** Nothing reports what the terminal is doing, so the user decides. */
  | { state: 'ask' }
  | { state: 'blocked'; text: string };

export type ShellFacts = {
  connected: boolean;
  tmux: boolean;
  fullScreen: boolean;
  /** Prompts are reported, so the next two can be trusted. */
  reportsPrompts: boolean;
  promptWaiting: boolean;
  promptHasText: boolean;
};

const busy = { state: 'blocked', text: '터미널이 사용 중입니다.' } as const;

/**
 * Whether a command can be typed in a shell now. tmux draws its own screen and keeps the prompt to
 * itself, so a tmux tab always looks full-screen and never reports a prompt.
 */
export function shellReadiness(facts: ShellFacts): TerminalReadiness {
  if (!facts.connected) return { state: 'blocked', text: '터미널이 연결되어 있지 않습니다.' };
  if (facts.tmux) return { state: 'ask' };
  if (facts.fullScreen) return busy;
  if (!facts.reportsPrompts) return { state: 'ask' };
  if (!facts.promptWaiting) return busy;
  if (facts.promptHasText)
    return { state: 'blocked', text: '터미널 프롬프트에 입력 중인 글자가 있습니다.' };
  return { state: 'ready' };
}

/** What a live tab's terminal says about itself right now. */
export function shellFacts(session: TerminalSession): ShellFacts {
  const snapshot = session.snapshot();
  const marks = commandMarksOf(session.terminal);
  return {
    connected: snapshot.status === 'connected' && !snapshot.replaying,
    tmux: !!session.profile.tmuxSession,
    fullScreen: session.terminal.buffer.active.type !== 'normal',
    reportsPrompts: marks?.reportsPrompts ?? false,
    promptWaiting: marks?.promptWaiting ?? false,
    promptHasText: marks?.promptHasText ?? false,
  };
}

/** As if the user typed the line and pressed Enter, so questions land where they can be answered. */
export function typeInTerminal(session: TerminalSession, command: string) {
  commandMarksOf(session.terminal)?.typedCommand();
  session.send(`${command}\r`);
  session.terminal.focus();
}
