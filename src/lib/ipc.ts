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
  lastConnected: number | null;
  hasSecret: boolean;
};
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
