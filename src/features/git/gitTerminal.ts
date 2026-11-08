import type { TerminalSession } from '../terminal/session';
import {
  shellFacts,
  shellReadiness,
  type ShellFacts,
  type TerminalReadiness,
} from '../terminal/shellReadiness';
import { gitPath, inside } from './gitStatus';

export { typeInTerminal, type TerminalReadiness } from '../terminal/shellReadiness';

export type TerminalFacts = ShellFacts & {
  /** The folder the shell is in, when anything reports it. */
  directory?: string | null;
  root: string;
};

/** A Git command also needs the shell to be in the repository. */
export function terminalReadiness(facts: TerminalFacts): TerminalReadiness {
  if (!facts.connected) return { state: 'blocked', text: '터미널이 연결되어 있지 않습니다.' };
  if (!facts.directory)
    return { state: 'blocked', text: '터미널의 현재 폴더를 알 수 없어 실행하지 않았습니다.' };
  if (!inside(gitPath(facts.directory), gitPath(facts.root)))
    return {
      state: 'blocked',
      text: '터미널이 이 저장소 폴더에 있지 않습니다. 터미널에서 저장소로 이동한 뒤 다시 시도하세요.',
    };
  return shellReadiness(facts);
}

/** The facts of a live tab. A tmux tab asks tmux for its folder first, since it is not reported. */
export async function readinessOf(session: TerminalSession, root: string) {
  if (session.profile.tmuxSession) await session.syncTmuxDirectory();
  return terminalReadiness({
    ...shellFacts(session),
    directory: session.snapshot().directory,
    root,
  });
}
