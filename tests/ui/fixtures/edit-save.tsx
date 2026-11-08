// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { createRoot } from 'react-dom/client';
import type { ExternalEdit } from '../../../src/lib/externalEdit';
import { EditSaveCard } from '../../../src/features/terminal/EditSaveCard';
import type { EditSaveAnswer } from '../../../src/features/terminal/editSave';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

declare global {
  interface Window {
    __edit: ExternalEdit;
    __editAnswer: EditSaveAnswer | null;
  }
}

applyTheme(getCurrentTheme());
window.__editAnswer = null;

createRoot(document.getElementById('root')!).render(
  // The same neighbour as in TerminalPane, so the card has to share the pane's height.
  <section className="terminal-pane" style={{ height: 420 }}>
    <EditSaveCard
      edit={window.__edit}
      answer={(answer) => {
        window.__editAnswer = answer;
      }}
    />
    <div className="live-terminal" />
  </section>,
);
