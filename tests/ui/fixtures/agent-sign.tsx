// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { createRoot } from 'react-dom/client';
import { AgentSignCard } from '../../../src/features/terminal/AgentSignCard';
import type { PendingSign, SignAnswer, SignReply } from '../../../src/features/terminal/agentSign';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

declare global {
  interface Window {
    __signRequest: PendingSign;
    __signAnswer: SignAnswer | null;
    /** Replies the backend would give, in order. Empty means done. */
    __signReplies: SignReply[];
  }
}

applyTheme(getCurrentTheme());
window.__signAnswer = null;
window.__signReplies ??= [];

createRoot(document.getElementById('root')!).render(
  // The same neighbour as in TerminalPane, so the card has to share the pane's height.
  <section className="terminal-pane" style={{ height: 420 }}>
    <AgentSignCard
      request={window.__signRequest}
      answer={(answer) => {
        window.__signAnswer = answer;
        return Promise.resolve(window.__signReplies.shift() ?? null);
      }}
    />
    <div className="live-terminal" />
  </section>,
);
