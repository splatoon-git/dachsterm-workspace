// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { createRoot } from 'react-dom/client';
import { AgentLaunchDialog } from '../../../src/features/agents/AgentLaunchDialog';
import { blankProfile, type TerminalLaunch } from '../../../src/lib/ipc';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';

declare global {
  interface Window {
    __tmux: string;
    __folder: string | undefined;
    __launch: TerminalLaunch | null;
    __closed: boolean;
  }
}

applyTheme(getCurrentTheme());
window.__launch = null;
window.__closed = false;

createRoot(document.getElementById('root')!).render(
  <AgentLaunchDialog
    profile={{ ...blankProfile(), name: '개발 서버', tmuxSession: window.__tmux }}
    folder={window.__folder}
    start={(launch) => (window.__launch = launch)}
    close={() => (window.__closed = true)}
  />,
);
