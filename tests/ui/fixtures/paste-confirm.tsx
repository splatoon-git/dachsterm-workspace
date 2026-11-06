// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { createRoot } from 'react-dom/client';
import { PasteConfirm } from '../../../src/features/terminal/PasteConfirm';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

declare global {
  interface Window {
    __pasteText: string;
    __pasteResult: string;
  }
}

applyTheme(getCurrentTheme());
window.__pasteResult = '';

createRoot(document.getElementById('root')!).render(
  // A short pane with the same neighbour as TerminalPane, so the card has to share the height.
  <section className="terminal-pane" style={{ height: 400 }}>
    <PasteConfirm
      text={window.__pasteText}
      cancel={() => (window.__pasteResult = 'cancel')}
      confirm={() => (window.__pasteResult = 'confirm')}
    />
    <div className="live-terminal" />
  </section>,
);
