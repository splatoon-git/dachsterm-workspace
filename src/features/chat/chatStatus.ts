import type { ChatState } from './chatState';

/**
 * What a chat tab reports to its tab and the agent list (AC.4), in the words a terminal tab uses
 * for a program's state. Only states that ask something of the user, or show work under way, are
 * reported; a chat sitting ready reports nothing, like an idle terminal.
 */
export type ChatSummary = {
  state: 'blocked' | 'working';
  kind?: 'permission' | 'question';
  /** Plain text for the tooltip. */
  detail: string;
};

export function chatSummary(state: ChatState): ChatSummary | null {
  if (state.phase === 'ended') return null;
  // The first card asked is the one the agent waits on; the others come after it.
  const asked = state.items.find((item) => item.kind === 'approval' && item.status === 'pending');
  if (asked?.kind === 'approval') {
    const question = asked.questions.length > 0;
    const what = question ? asked.questions[0].question : `${asked.tool} ${asked.summary}`;
    const away = state.phase === 'disconnected' ? ' (연결 끊김, 다시 연결해 답하기)' : '';
    return {
      state: 'blocked',
      kind: question ? 'question' : 'permission',
      detail: `${what.trim()}${away}`,
    };
  }
  if (state.phase === 'working') return { state: 'working', detail: '' };
  return null;
}
