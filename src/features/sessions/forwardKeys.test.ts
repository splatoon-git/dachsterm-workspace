import { describe, expect, it } from 'vitest';
import { addProblem, fileName, keyDetail, MAX_FORWARD_KEYS, type KeyInfo } from './forwardKeys';

const info: KeyInfo = {
  path: 'C:\\Users\\me\\.ssh\\id_git',
  name: 'id_git',
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:abc',
  comment: 'git',
  encrypted: false,
};

describe('forwarded key list', () => {
  it('adds a new file up to the limit', () => {
    expect(addProblem([], 'a')).toBeNull();
    expect(addProblem([], '')).toContain('경로');
    expect(addProblem([{ path: 'a' }], 'a')).toContain('이미');
    const full = Array.from({ length: MAX_FORWARD_KEYS }, (_, i) => ({ path: String(i) }));
    expect(addProblem(full, 'new')).toContain('최대 8개');
  });
  it('names a row by its file on both systems', () => {
    expect(fileName('C:\\Users\\me\\.ssh\\id_git')).toBe('id_git');
    expect(fileName('/Users/me/.ssh/id_ed25519')).toBe('id_ed25519');
  });
  it('shows the algorithm and fingerprint, or why they are unknown', () => {
    expect(keyDetail(info)).toBe('ssh-ed25519 · SHA256:abc');
    expect(keyDetail({ ...info, encrypted: true })).toBe(
      'ssh-ed25519 · SHA256:abc · Passphrase 필요',
    );
    expect(keyDetail({ ...info, fingerprint: null, algorithm: '' })).toContain('.pub');
    expect(keyDetail('개인키 파일을 읽을 수 없습니다.')).toBe('개인키 파일을 읽을 수 없습니다.');
    expect(keyDetail(undefined)).toBe('확인 중…');
  });
});
