// Synthetic data for visual layout checks. No commands reach a desktop backend.
import type { GeneratedKey } from '../../../src/components/SshKeyDialog';
import type { ForwardKey } from '../../../src/lib/ipc';
import type { LocalAgent } from '../../../src/features/agents/useLocalAgent';
import type { SessionTemplate } from '../../../src/features/sessions/SessionManager';
import type { Found } from '../../../src/features/sessions/localImport';
import type { UpdateStatus } from '../../../src/features/updates/updateState';

export const longName = 'production_service_' + 'configuration_'.repeat(8);
export const longPath = `C:\\Users\\layout-test\\${longName}\\.ssh\\id_ed25519`;
const key: ForwardKey = { path: longPath };
const templates: SessionTemplate[] = [{ id: 'template', name: longName, options: { port: 22 } }];
const found: Found[] = [
  { source: 'openssh', place: longPath, count: 24, skipped: 0, include: true, problem: null },
];
const agent: LocalAgent = { enabled: true, keys: [key], wslGitCredentials: true };
const made: GeneratedKey = {
  path: longPath,
  publicKey: 'ssh-ed25519 AAAAC3Nza-layout-fixture layout@example.test',
  fingerprint: 'SHA256:layout-fixture',
};

export function installDialogBridge(params: URLSearchParams) {
  const variant = params.get('state') ?? 'normal';
  const failure = '점검용 오류: 선택한 경로를 읽을 수 없습니다. ' + longPath;
  Object.defineProperty(window, 'isTauri', { value: true });
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {
      invoke: async (command: string) => {
        if (variant === 'error' && !['local_targets', 'vault_status'].includes(command))
          throw failure;
        switch (command) {
          case 'local_targets':
            return {
              targets: [{ id: 'pwsh', name: 'PowerShell', kind: 'shell', follow: 'launch' }],
              warning: null,
            };
          case 'git_program_info':
            return {
              chosen: longPath,
              found: longPath,
              version: 'git version 2.50',
              problem: null,
            };
          case 'git_config_read':
            return [
              { key: 'user.name', values: [longName], hidden: false },
              { key: 'user.email', values: ['layout@example.test'], hidden: false },
            ];
          case 'local_agent_settings':
            return agent;
          case 'git_credentials_saved':
            return [{ host: `${longName}.example.test`, username: longName }];
          case 'vault_status':
            return { enabled: variant !== 'new', unlocked: variant === 'unlocked', seconds: 300 };
          case 'session_templates':
            return templates;
          case 'config_detect':
            return found;
          case 'recovery_list':
            return [{ id: 'recovery-fixture', modified: 1794956400 }];
          case 'update_status': {
            const status: UpdateStatus = {
              current: '0.5.1',
              auto: true,
              unavailable: null,
              phase:
                variant === 'download'
                  ? { state: 'downloading', version: '0.5.2', received: 1024, total: 4096 }
                  : {
                      state: 'available',
                      version: '0.5.2',
                      date: null,
                      notes:
                        `업데이트 안내\n${longName}\n` +
                        '설정과 저장된 세션을 유지합니다.\n'.repeat(20),
                    },
            };
            return status;
          }
          case 'ssh_key_defaults':
            return { folder: longPath, comment: 'layout@example.test' };
          case 'ssh_key_generate':
            return made;
          case 'ssh_key_info':
            return {
              ...made,
              name: longName,
              algorithm: 'ssh-ed25519',
              comment: 'layout@example.test',
              encrypted: false,
            };
          case 'editor_list':
            return [
              { id: 'code', name: '코드 편집기', path: longPath },
              { id: 'text', name: '텍스트 편집기', path: longPath },
            ];
          case 'tunnel_configs':
            return [];
          case 'tunnel_list':
            return [];
          case 'remote_ports':
            return [
              { host: '127.0.0.1', port: 8080 },
              { host: '::', port: 3000 },
            ];
          case 'git_refs':
            return {
              refs: [
                'refs/heads/main',
                `refs/heads/${longName}`,
                `refs/remotes/origin/${longName}`,
              ],
              truncated: false,
            };
          case 'log_auto_get':
            return {
              directory: longPath,
              timestamps: true,
              maxBytes: 10485760,
              keepFiles: 10,
              daily: true,
            };
          case 'log_status':
            return { state: 'off', path: '', message: '', bytes: 0 };
          case 'serial_ports':
            return [];
          case 'clipboard_write_text':
            return null;
          default:
            throw `Unexpected layout fixture command: ${command}`;
        }
      },
    },
  });
}
