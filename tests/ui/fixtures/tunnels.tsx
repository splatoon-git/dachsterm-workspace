// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import type { TerminalSession } from '../../../src/features/terminal/session';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

type Config = {
  id: string;
  profileId: string;
  name: string;
  kind: string;
  port: number;
  host: string;
  targetPort: number;
  autoStart: boolean;
};
type Status = {
  id: string;
  connectionId: string;
  name: string;
  kind: string;
  port: number;
  status: string;
  message: string;
};
declare global {
  interface Window {
    __tunnelTest: {
      configs: Config[];
      statuses: Status[];
      failSave: boolean;
      failStart: boolean;
      failList: boolean;
      calls: string[];
      disconnect: () => void;
    };
  }
}
const state = (window.__tunnelTest = {
  configs: [] as Config[],
  statuses: [] as Status[],
  failSave: false,
  failStart: false,
  failList: false,
  calls: [] as string[],
  disconnect: () => {},
});
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (command: string, args: { configs: Config[]; config: Config; id: string }) => {
      state.calls.push(command);
      if (command === 'tunnel_configs') return structuredClone(state.configs);
      if (command === 'tunnel_list') {
        if (state.failList) throw '상태 읽기 실패';
        return structuredClone(state.statuses);
      }
      if (command === 'tunnel_save') {
        if (state.failSave) throw '저장 실패 테스트';
        state.configs = structuredClone(args.configs);
      }
      if (command === 'tunnel_start') {
        if (state.failStart) throw '포트 충돌 테스트';
        state.statuses = [
          {
            ...args.config,
            id: `${args.id}:${args.config.id}`,
            connectionId: args.id,
            port: args.config.port || 45678,
            status: 'running',
            message: '',
          },
        ];
      }
      if (command === 'tunnel_stop')
        state.statuses = state.statuses.map((s) =>
          s.id === args.id ? { ...s, status: 'stopped' } : s,
        );
    },
  },
});
const { TunnelPanel } = await import('../../../src/features/tunnels/TunnelPanel');
const { blankProfile } = await import('../../../src/lib/ipc');
const profile = {
  ...blankProfile(),
  id: 'ssh-1',
  name: '개발 서버',
  host: 'dev.example.test',
  username: 'developer',
};
let connectionState = 'connected';
const listeners = new Set<() => void>();
const session = {
  profile,
  connectionId: 'connection-1',
  snapshot: () => ({ status: connectionState }),
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
} as unknown as TerminalSession;
state.disconnect = () => {
  connectionState = 'closed';
  listeners.forEach((fn) => fn());
};
applyTheme(getCurrentTheme());
createRoot(document.getElementById('root')!).render(
  <TunnelPanel
    sessions={[session]}
    session={session}
    profiles={[profile, { ...profile, id: 'ftp', name: 'FTP 제외', protocol: 'ftp' }]}
    close={() => {}}
  />,
);
