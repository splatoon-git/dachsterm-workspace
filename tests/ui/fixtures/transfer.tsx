import React from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';
import type { Found } from '../../../src/features/sessions/localImport';
import type { Profile } from '../../../src/lib/ipc';
import {
  onSettingsRequest,
  type ImportSource,
  type SettingsRequest,
} from '../../../src/lib/settingsRequest';

declare global {
  interface Window {
    __transferTest: {
      fail: boolean;
      cancel: boolean;
      command: boolean;
      /** Adds a Telnet and a serial session, which keep no user name. */
      consoles: boolean;
      /** Adds an FTP session with no user name, which FTP cannot do without. */
      ftp: boolean;
      applied: string[];
      approved: unknown[];
      /** What `config_detect` reports on this PC (I.2). */
      found: Found[];
      /** Settings the import offer asked to open. */
      requests: SettingsRequest[];
      /** The found source each file pick was asked to read like, `null` for a plain pick. */
      picks: (ImportSource | null)[];
    };
  }
}
const state = (window.__transferTest = {
  fail: false,
  cancel: false,
  command: false,
  consoles: false,
  ftp: false,
  applied: [] as string[],
  approved: [] as unknown[],
  found: [] as Found[],
  requests: [] as SettingsRequest[],
  picks: [] as (ImportSource | null)[],
});
const params = new URLSearchParams(location.search);
if (params.has('found'))
  state.found = [
    { source: 'putty', place: 'HKCU', count: 2, skipped: 0, include: false, problem: null },
    { source: 'bookmarks', place: 'b.ini', count: 0, skipped: 1, include: false, problem: null },
    { source: 'openssh', place: 'config', count: 0, skipped: 0, include: false, problem: '오류' },
  ];
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (
      command: string,
      args: { data: string; approved?: unknown; source?: ImportSource; like?: ImportSource },
    ) => {
      if (command === 'config_export') return !state.cancel;
      if (command === 'config_detect') return state.found;
      if (command === 'config_preview_found' && args.source === 'bookmarks')
        return {
          source: '세션 북마크',
          bundle: {
            format: 'dachsterm.sessions',
            version: 4,
            profiles: [],
            groups: [],
            tunnels: [],
          },
          warnings: ['프록시를 거치는 세션은 제외했습니다.'],
          skipped: 1,
        };
      if (command === 'config_preview_found') {
        const lab = { ...saved, id: 'lab', name: 'Lab', host: 'lab.example.com', groupId: null };
        return {
          source: 'PuTTY',
          bundle: {
            format: 'dachsterm.sessions',
            version: 4,
            profiles: [lab, { ...saved, id: 'copy', name: '같은 대상', groupId: 'seoul' }],
            groups: [
              { id: 'dev', name: '개발', parentId: null, sortOrder: 0 },
              { id: 'seoul', name: '서울', parentId: 'dev', sortOrder: 0 },
            ],
            tunnels: [],
          },
          warnings: [],
          skipped: 0,
        };
      }
      if (command === 'config_apply') {
        if (state.fail) throw '가져오기 실패 테스트';
        state.applied.push(args.data);
        state.approved.push(args.approved ?? null);
        return JSON.parse(args.data).profiles.length;
      }
      if (command === 'config_preview') {
        state.picks.push(args.like ?? null);
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
              ...(state.ftp
                ? [{ ...p, id: 'ftp', name: '파일 서버', protocol: 'ftp', port: 21 }]
                : []),
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
// `ipc` reads `isTauri` when it loads, so it comes in after the stand-in above.
const { blankProfile } = await import('../../../src/lib/ipc');
const saved: Profile = {
  ...blankProfile(),
  id: 'saved',
  name: '저장된 서버',
  host: 'saved.example.com',
  username: 'ops',
};
const { SessionTransfer } = await import('../../../src/features/sessions/SessionTransfer');
const { ImportOffer } = await import('../../../src/features/sessions/FoundSources');
const { Dialog } = await import('../../../src/components/Dialog');
applyTheme(getCurrentTheme());
onSettingsRequest((request) => state.requests.push(request));
const from = params.get('from') as ImportSource | null;
createRoot(document.getElementById('root')!).render(
  params.has('offer') ? (
    <ImportOffer />
  ) : (
    <Dialog title="세션 교환 테스트" className="settings-dialog" close={() => {}}>
      <SessionTransfer changed={() => {}} profiles={[saved]} importFrom={from ?? undefined} />
    </Dialog>
  ),
);
