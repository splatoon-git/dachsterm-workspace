// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { createRoot } from 'react-dom/client';
import { GitCredentialCard } from '../../../src/features/terminal/GitCredentialCard';
import type {
  CredentialAnswer,
  CredentialReply,
  PendingCredential,
} from '../../../src/features/terminal/agentSign';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

declare global {
  interface Window {
    __credentialRequest: PendingCredential;
    __credentialAnswers: CredentialAnswer[];
    /** Replies the backend would give, in order. Empty means done. */
    __credentialReplies: CredentialReply[];
  }
}

applyTheme(getCurrentTheme());
window.__credentialAnswers = [];
window.__credentialReplies ??= [];

createRoot(document.getElementById('root')!).render(
  // The same neighbour as in TerminalPane, so the card has to share the pane's height.
  <section className="terminal-pane" style={{ height: 420 }}>
    <GitCredentialCard
      request={window.__credentialRequest}
      answer={(answer) => {
        window.__credentialAnswers.push(answer);
        return Promise.resolve(window.__credentialReplies.shift() ?? null);
      }}
    />
    <div className="live-terminal" />
  </section>,
);
