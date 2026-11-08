import type { ForwardKey } from '../lib/ipc';

/** What `ssh_key_info` returns: the public part of a key file only. */
export type KeyInfo = {
  path: string;
  name: string;
  algorithm: string;
  fingerprint: string | null;
  comment: string;
  encrypted: boolean;
};

/** The same limit `Profile::validate` enforces. */
export const MAX_FORWARD_KEYS = 8;

/** Why a path cannot be added, or null. The backend checks again on save. */
export function addProblem(keys: readonly ForwardKey[], path: string): string | null {
  if (!path) return '키 파일 경로를 입력하세요.';
  if (keys.length >= MAX_FORWARD_KEYS) return `전달할 키는 최대 ${MAX_FORWARD_KEYS}개입니다.`;
  if (keys.some((key) => key.path === path)) return '이미 목록에 있는 키 파일입니다.';
  return null;
}

/** The file name a row shows before its details are read. */
export const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** One row's details: an error from reading the file, or the algorithm and fingerprint. */
export function keyDetail(info: KeyInfo | string | undefined): string {
  if (info === undefined) return '확인 중…';
  if (typeof info === 'string') return info;
  if (!info.fingerprint) return '공개키를 읽을 수 없음 · 같은 이름의 .pub 파일을 옆에 두세요';
  return [info.algorithm, info.fingerprint, info.encrypted ? 'Passphrase 필요' : '']
    .filter(Boolean)
    .join(' · ');
}
