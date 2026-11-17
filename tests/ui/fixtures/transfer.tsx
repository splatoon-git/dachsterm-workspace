import React from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';

declare global {
  interface Window {
    __transferTest: {
      fail: boolean;
      cancel: boolean;
      command: boolean;
      /** Adds a Telnet and a serial session, which keep no user name. */
      consoles: boolean;
      applied: string[];
      approved: unknown[];
    };
  }
}
const state = (window.__transferTest = {
  fail: false,
  cancel: false,
  command: false,
  consoles: false,
  applied: [] as string[],
  approved: [] as unknown[],
});
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (command: string, args: { data: string; approved?: unknown }) => {
      if (command === 'config_export') return !state.cancel;
      if (command === 'config_apply') {
        if (state.fail) throw '가져오기 실패 테스트';
        state.applied.push(args.data);
        state.approved.push(args.approved ?? null);
        return JSON.parse(args.data).profiles.length;
      }
      if (command === 'config_preview') {
        if (state.cancel) return null;
        const p = {
          id: 'one',
          name: '개발 서버',
          host: 'dev.example.com',
          port: 22,
          username: '',
          auth: 'password',
          protocol: 'ssh',
          tlsCaPath: '',
          encoding: 'utf-8',
          keyPath: '',
          groupId: 'g',
          favorite: false,
          timeout: 15,
          keepalive: 15,
          hasSecret: false,
          lastConnected: null,
        };
        const command = 'ssh -W %h:%p bastion';
        const relay = { ...p, id: 'cmd', name: '명령 경유', username: 'ops', groupId: 'g' };
        return {
          commandPlan: state.command
            ? { token: 'plan', sessions: [{ id: 'cmd', name: '명령 경유', command }] }
            : null,
          bundle: {
            format: 'dachsterm.sessions',
            version: 4,
            profiles: [
              p,
              { ...p, id: 'two', name: '운영 서버', username: 'operator', groupId: 'other' },
              ...(state.command ? [{ ...relay, proxy: { kind: 'command', command } }] : []),
              ...(state.consoles
                ? [
                    {
                      ...p,
                      id: 'tel',
                      name: '스위치 콘솔',
                      protocol: 'telnet',
                      auth: 'interactive',
                    },
                    {
                      ...p,
                      id: 'ser',
                      name: '보드 시리얼',
                      protocol: 'serial',
                      auth: 'interactive',
                      host: '/dev/cu.usbserial',
                      port: 0,
                      serial: {
                        baud: 115200,
                        dataBits: 8,
                        parity: 'none',
                        stopBits: 1,
                        flow: 'none',
                      },
                    },
                  ]
                : []),
            ],
            groups: [
              { id: 'g', name: '개발' },
              { id: 'other', name: '운영' },
            ],
            tunnels: [{ id: 't', profileId: 'two', autoStart: false }],
          },
          warnings: ['추가 설정은 가져오지 않습니다.'],
          skipped: 1,
        };
      }
      throw 'Unexpected fixture command';
    },
  },
});
const { SessionTransfer } = await import('../../../src/features/sessions/SessionTransfer');
const { Dialog } = await import('../../../src/components/Dialog');
applyTheme(getCurrentTheme());
createRoot(document.getElementById('root')!).render(
  <Dialog title="세션 교환 테스트" className="settings-dialog" close={() => {}}>
    <SessionTransfer changed={() => {}} />
  </Dialog>,
);
