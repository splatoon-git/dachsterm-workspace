// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalPane } from '../../../src/features/terminal/TerminalPane';
import { TerminalSession } from '../../../src/features/terminal/session';
import { TerminalSettings } from '../../../src/features/terminal/TerminalSettings';
import type { Profile } from '../../../src/lib/ipc';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

declare global {
  interface Window {
    __terminalPane: {
      session: TerminalSession;
      sent: string[];
      setActive: (active: boolean) => void;
    };
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

function Fixture() {
  const [active, setActive] = useState(true);
  const [settings, setSettings] = useState(false);
  useEffect(() => {
    window.__terminalPane = { session, sent, setActive };
  }, []);
  return (
    <>
      <input aria-label="터미널 밖 입력" />
      {/* The app opens these settings from its settings dialog. */}
      <button onClick={() => setSettings(true)}>터미널 설정</button>
      {settings && <TerminalSettings close={() => setSettings(false)} />}
      <div style={{ height: 560, display: 'flex', flexDirection: 'column' }}>
        <TerminalPane session={session} active={active} theme={theme} reconnect={() => {}} />
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
