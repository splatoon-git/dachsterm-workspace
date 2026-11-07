// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StatusBar } from '../../../src/app/StatusBar';
import { sortRows, type AgentRow } from '../../../src/app/agentRows';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

declare global {
  interface Window {
    __agentRows: AgentRow[];
    __activated: string[];
    __setAgentRows: (rows: AgentRow[]) => void;
  }
}

applyTheme(getCurrentTheme());
window.__activated = [];

function Fixture() {
  const [rows, setRows] = useState(() => sortRows(window.__agentRows));
  window.__setAgentRows = (next) => setRows(sortRows(next));
  return (
    <>
      <main style={{ flex: 1 }}>
        <button type="button">작업 영역</button>
      </main>
      <StatusBar agents={{ rows, activate: (row) => window.__activated.push(row.key) }} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
