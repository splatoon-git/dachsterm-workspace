import type { TerminalLaunch } from '../../lib/ipc';
import { startLine } from '../../lib/shell';
import type { TerminalSession } from './session';

/**
 * How a start command ended. `noPrompt` means nothing was typed in time and the user should run it
 * themselves, and `ended` that the tab closed or lost its connection first.
 */
export type LaunchResult = 'none' | 'sent' | 'typed' | 'noPrompt' | 'ended';

/** The parts of a tab the typed start needs, so the timing can be tested without a terminal. */
export type PromptTarget = {
  state(): { status: string; directoryHook?: string };
  /** False once the tab closes or reconnects, since a new shell must not get the command. */
  current(): boolean;
  atPrompt(): boolean;
  type(text: string): void;
};

export const launchTimes = {
  /** Sign-in, a host key question or a one-time code may come first. */
  connectMs: 180_000,
  /** The session hook types first; it gives up on its own within about 20 seconds. */
  hookMs: 40_000,
  promptMs: 10_000,
  stepMs: 100,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Types the start line once, only at an idle prompt and only after the session hook is in, so
 * neither lands inside the other or inside a program. Without a prompt in time nothing is typed.
 */
export async function typeAtPrompt(
  target: PromptTarget,
  text: string,
  times = launchTimes,
): Promise<LaunchResult> {
  let deadline = Date.now() + times.connectMs;
  let phase: 'connect' | 'hook' | 'prompt' = 'connect';
  for (;;) {
    const { status, directoryHook } = target.state();
    if (!target.current() || status === 'closed' || status === 'error') return 'ended';
    const next =
      status !== 'connected' ? 'connect' : directoryHook === 'waiting' ? 'hook' : 'prompt';
    if (next !== phase) {
      phase = next;
      deadline = Date.now() + (next === 'hook' ? times.hookMs : times.promptMs);
    }
    if (phase === 'prompt' && target.atPrompt()) {
      target.type(`${text}\r`);
      return 'typed';
    }
    if (Date.now() > deadline) return 'noPrompt';
    await sleep(times.stepMs);
  }
}

/**
 * Connects a new tab and starts its command. A tmux session takes it in `connect` and types it
 * only into a session it creates; a plain shell gets it typed at its first prompt.
 */
export async function connectWithLaunch(
  session: TerminalSession,
  secret: string | null,
  remember: boolean,
  launch?: TerminalLaunch,
): Promise<LaunchResult> {
  if (!launch) {
    await session.connect(secret, remember);
    return 'none';
  }
  if (session.profile.tmuxSession) {
    await session.connect(secret, remember, launch);
    return 'sent';
  }
  await session.connect(secret, remember);
  const id = session.connectionId;
  return typeAtPrompt(
    {
      state: session.snapshot,
      current: () => !session.disposed && session.connectionId === id,
      atPrompt: () => session.directoryHookInstaller.atPrompt(),
      type: (text) => session.send(text),
    },
    startLine(launch),
  );
}
