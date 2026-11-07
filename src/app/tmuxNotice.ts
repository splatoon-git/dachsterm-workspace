import type { Profile } from '../lib/ipc';

const seenKey = 'dachsterm.tmuxCloseNoticeSeen';

/** Closing a tab leaves the server's tmux session running, which is worth saying exactly once. */
export function tmuxCloseNotice(profile: Profile, storage: Storage = localStorage) {
  if (!profile.tmuxSession) return null;
  try {
    if (storage.getItem(seenKey) === '1') return null;
    storage.setItem(seenKey, '1');
  } catch {
    // Without storage the note may repeat, which is better than never saying it.
  }
  return `탭을 닫아도 서버의 tmux 세션 '${profile.tmuxSession}'은 계속 실행됩니다. 끝내려면 서버에서 tmux를 종료하세요.`;
}
