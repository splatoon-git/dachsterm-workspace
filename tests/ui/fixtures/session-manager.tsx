import React from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';
import '../../../src/features/sessions/transfer.css';
declare global {
  interface Window {
    __sessionBatch: unknown[];
  }
}
window.__sessionBatch = [];
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (command: string, args: unknown) => {
      if (command === 'session_templates') return [];
      if (command === 'session_batch') {
        window.__sessionBatch.push(args);
        return 2;
      }
      throw 'Unexpected command';
    },
  },
});
const { blankProfile } = await import('../../../src/lib/ipc');
const { SessionManager } = await import('../../../src/features/sessions/SessionManager');
const { Dialog } = await import('../../../src/components/Dialog');
applyTheme(getCurrentTheme());
const profiles = Array.from({ length: 500 }, (_, i) => ({
  ...blankProfile(),
  id: String(i),
  name: `서버 ${i}`,
  host: `host${i}.example`,
  username: 'app',
  tags: i < 2 ? ['prod'] : ['test'],
  groupId: 'child',
}));
createRoot(document.getElementById('root')!).render(
  <Dialog title="세션 관리 테스트" className="settings-dialog" close={() => {}}>
    <SessionManager
      snapshot={{
        profiles,
        groups: [
          { id: 'root', name: '운영' },
          { id: 'child', name: '서울', parentId: 'root' },
        ],
      }}
      changed={() => {}}
    />
  </Dialog>,
);
