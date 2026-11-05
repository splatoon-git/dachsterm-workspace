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
  groupId: string | null;
  favorite: boolean;
  timeout: number;
  keepalive: number;
  lastConnected: number | null;
  hasSecret: boolean;
};
export type Group = { id: string; name: string };
export type Snapshot = { profiles: Profile[]; groups: Group[]; credentialWarning?: string | null };
export const desktop = isTauri();
export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop)
    return Promise.reject('실제 연결과 저장은 DaxTerm 데스크톱 앱에서 사용할 수 있습니다.');
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
  groupId: null,
  favorite: false,
  timeout: 15,
  keepalive: 15,
  lastConnected: null,
  hasSecret: false,
});
export const errorText = (error: unknown) =>
  typeof error === 'string' ? error : '작업에 실패했습니다. 다시 시도하세요.';
