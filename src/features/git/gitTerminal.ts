import { commandMarksOf } from '../terminal/commandMarks';
import type { TerminalSession } from '../terminal/session';
import { gitPath, inside } from './gitStatus';

export type TerminalReadiness =
  | { state: 'ready' }
  /** Nothing reports what the terminal is doing, so the user decides. */
  | { state: 'ask' }
  | { state: 'blocked'; text: string };

export type TerminalFacts = {
  connected: boolean;
  /** The folder the shell is in, when anything reports it. */
  directory?: string | null;
  root: string;
  tmux: boolean;
  fullScreen: boolean;
  /** Prompts are reported, so the next three can be trusted. */
  reportsPrompts: boolean;
  promptWaiting: boolean;
  promptHasText: boolean;
};

const busy = { state: 'blocked', text: '터미널이 사용 중입니다.' } as const;

/**
 * Whether a command can be typed in the tab's terminal now. tmux draws its own screen and keeps the
 * prompt to itself, so a tmux tab always looks full-screen and never reports a prompt.
 */
export function terminalReadiness(facts: TerminalFacts): TerminalReadiness {
  if (!facts.connected) return { state: 'blocked', text: '터미널이 연결되어 있지 않습니다.' };
  if (!facts.directory)
    return { state: 'blocked', text: '터미널의 현재 폴더를 알 수 없어 실행하지 않았습니다.' };
  if (!inside(gitPath(facts.directory), gitPath(facts.root)))
    return {
      state: 'blocked',
      text: '터미널이 이 저장소 폴더에 있지 않습니다. 터미널에서 저장소로 이동한 뒤 다시 시도하세요.',
    };
  if (facts.tmux) return { state: 'ask' };
  if (facts.fullScreen) return busy;
  if (!facts.reportsPrompts) return { state: 'ask' };
  if (!facts.promptWaiting) return busy;
  if (facts.promptHasText)
    return { state: 'blocked', text: '터미널 프롬프트에 입력 중인 글자가 있습니다.' };
  return { state: 'ready' };
}

/** The facts of a live tab. A tmux tab asks tmux for its folder first, since it is not reported. */
export async function readinessOf(session: TerminalSession, root: string) {
  const tmux = !!session.profile.tmuxSession;
  if (tmux) await session.syncTmuxDirectory();
  const snapshot = session.snapshot();
  const marks = commandMarksOf(session.terminal);
  return terminalReadiness({
    connected: snapshot.status === 'connected' && !snapshot.replaying,
    directory: snapshot.directory,
    root,
    tmux,
    fullScreen: session.terminal.buffer.active.type !== 'normal',
    reportsPrompts: marks?.reportsPrompts ?? false,
    promptWaiting: marks?.promptWaiting ?? false,
    promptHasText: marks?.promptHasText ?? false,
  });
}

/** As if the user typed the line and pressed Enter, so questions land where they can be answered. */
export function typeInTerminal(session: TerminalSession, command: string) {
  commandMarksOf(session.terminal)?.typedCommand();
  session.send(`${command}\r`);
  session.terminal.focus();
}
