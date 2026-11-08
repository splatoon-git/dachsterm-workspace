import { invoke, isTauri } from '@tauri-apps/api/core';
export type Profile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: 'password' | 'key' | 'agent' | 'interactive';
  protocol: 'ssh' | 'ftp' | 'ftps';
  tlsCaPath: string;
  encoding: string;
  keyPath: string;
  jumpIds?: string[];
  tags?: string[];
  sortOrder?: number;
  groupId: string | null;
  favorite: boolean;
  timeout: number;
  keepalive: number;
  tmuxSession?: string;
  forwardAgent?: boolean;
  /** Built-in agent sources. Absent means the default: true, none, true. */
  forwardLoginKey?: boolean;
  forwardKeys?: ForwardKey[];
  forwardSystemAgent?: boolean;
  /** HTTPS Git credentials through the server's git. Off unless the form turns it on. */
  forwardGitCredentials?: boolean;
  /** What the tab shows after connecting. Absent means the terminal. */
  workspace?: 'terminal' | 'kubernetes';
  /** Filled by the first connection's detection. Only the backend writes it. */
  kube?: KubeSettings | null;
  lastConnected: number | null;
  hasSecret: boolean;
};
/** Paths and names on the server; a kubeconfig's contents never reach the app. */
export type KubeSettings = {
  context: string;
  /** Empty means every namespace. */
  namespace: string;
  kubectl: string;
  kubeconfig: string;
  operate: boolean;
};
/** A tab on an SSH connection that is already open. `kube_terminal_open` runs a fixed command. */
export type PodTerminalLaunch =
  | {
      kind: 'podShell';
      connection: string;
      kube: KubeSettings;
      namespace: string;
      pod: string;
      container: string;
    }
  | {
      kind: 'podLogs';
      connection: string;
      kube: KubeSettings;
      namespace: string;
      pod: string;
      container: string;
      tail: number;
    };
/** A key file the built-in agent offers. Only the backend sets `secretRef`. */
export type ForwardKey = { path: string; secretRef?: string | null };
/** A one-time start command for a new tab, given to `connect` and never saved. */
export type TerminalLaunch = { folder: string; command: string };
export type Group = { id: string; name: string; parentId?: string | null; sortOrder?: number };
export type Snapshot = { profiles: Profile[]; groups: Group[]; credentialWarning?: string | null };
export const desktop = isTauri();
export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop)
    return Promise.reject('실제 연결과 저장은 DachsTerm 데스크톱 앱에서 사용할 수 있습니다.');
  return invoke<T>(command, args);
}
export const blankProfile = (): Profile => ({
  id: '',
  name: '',
  host: '',
  port: 22,
  username: '',
  auth: 'password',
  protocol: 'ssh',
  tlsCaPath: '',
  encoding: 'utf-8',
  keyPath: '',
  jumpIds: [],
  tags: [],
  sortOrder: 0,
  groupId: null,
  favorite: false,
  timeout: 15,
  keepalive: 15,
  lastConnected: null,
  hasSecret: false,
});
/** A message written for the user. Other Error objects stay generic in errorText. */
export class UserError extends Error {}
export function errorText(error: unknown) {
  if (typeof error === 'string') return error;
  return error instanceof UserError ? error.message : '작업에 실패했습니다. 다시 시도하세요.';
}
