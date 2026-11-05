import React from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';
import type { Transfer } from '../../../src/features/sftp/TransferQueue';

declare global {
  interface Window {
    __queueCalls: { command: string; args: Record<string, unknown> }[];
  }
}
window.__queueCalls = [];
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (command: string, args: Record<string, unknown>) => {
      window.__queueCalls.push({ command, args });
      if (command === 'transfer_items')
        return [
          {
            name: '/한글 폴더/중첩 폴더/동일한 파일.txt',
            directory: false,
            size: 1024,
            status: 'completed',
          },
        ];
      return null;
    },
  },
});
const { TransferQueue } = await import('../../../src/features/sftp/TransferQueue');
applyTheme(getCurrentTheme());
const transfers: Transfer[] = [
  'running',
  'queued',
  'scanning',
  'paused',
  'failed',
  'completed',
  'cancelled',
].map((status, i) => ({
  id: `job-${i}`,
  connectionId: 'old-connection',
  profileId: 'server',
  name: `/한글 폴더 ${i}`,
  direction: 'upload',
  done: 1024,
  total: 4096,
  files: 4,
  finished: 1,
  skipped: 1,
  status,
  message: status === 'failed' ? '권한 오류 · 부분 파일 보존' : '부분 파일·빈 폴더 보존',
  conflict: 'skip',
  current: '중첩/파일.txt',
  currentDone: 1024,
  currentTotal: 3072,
}));
createRoot(document.getElementById('root')!).render(
  <div
    className="files"
    style={{ display: 'flex', maxWidth: 440, minWidth: 0, height: 'auto', margin: 'auto' }}
  >
    <TransferQueue
      transfers={transfers}
      connectionId="new-authenticated-connection"
      profileId="server"
      run={async (command, args) => {
        window.__queueCalls.push({ command, args });
        return true;
      }}
      discard={(id) => window.__queueCalls.push({ command: 'discard-confirm', args: { id } })}
    />
  </div>,
);
