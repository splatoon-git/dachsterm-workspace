// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { createRoot } from 'react-dom/client';
import { TerminalPane } from '../../../src/features/terminal/TerminalPane';
import { TerminalSession } from '../../../src/features/terminal/session';
import type { Profile } from '../../../src/lib/ipc';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

declare global {
  interface Window {
    __terminalPane: { session: TerminalSession; sent: string[] };
  }
}

const profile: Profile = {
  id: 'fixture',
  name: '테스트 터미널',
  host: 'example.invalid',
  port: 22,
  username: 'tester',
  auth: 'password',
  protocol: 'ssh',
  tlsCaPath: '',
  encoding: 'utf-8',
  keyPath: '',
  groupId: null,
  favorite: false,
  timeout: 10,
  keepalive: 30,
  lastConnected: null,
  hasSecret: false,
};

const theme = getCurrentTheme();
applyTheme(theme);
const session = new TerminalSession(profile, theme, () => {});
const sent: string[] = [];
session.terminal.onData((data) => sent.push(data));
window.__terminalPane = { session, sent };

createRoot(document.getElementById('root')!).render(
  <>
    <input aria-label="터미널 밖 입력" />
    <div style={{ height: 560, display: 'flex', flexDirection: 'column' }}>
      <TerminalPane session={session} active theme={theme} reconnect={() => {}} />
    </div>
  </>,
);
