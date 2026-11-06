import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { TerminalSession } from '../terminal/session';

/** Shared by the remote and local panels, because a connection's terminal drives both. */
export function useDirectoryFollow(
  session: TerminalSession,
  load: (path: string) => unknown,
  paused = false,
) {
  const [follow, setFollow] = useState(() => session.wantsDirectoryFollow());
  const lastDirectory = useRef<string | null>(null);
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  useEffect(() => {
    if (
      follow &&
      !paused &&
      state.status === 'connected' &&
      state.directory &&
      state.directory !== lastDirectory.current
    ) {
      lastDirectory.current = state.directory;
      void load(state.directory);
    }
  }, [follow, load, paused, state.directory, state.status]);
  return {
    follow,
    setFollow(value: boolean) {
      lastDirectory.current = null;
      session.setFollowDirectory(value);
      setFollow(value);
    },
  };
}

export function FollowControl({
  session,
  follow,
  setFollow,
}: {
  session: TerminalSession;
  follow: boolean;
  setFollow: (value: boolean) => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const waiting = state.directoryHook === 'waiting';
  const unavailable = follow && !state.directory && !waiting;
  return (
    <>
      <label>
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
        터미널 경로 따라가기
      </label>
      {unavailable && (
        <small className="file-follow-note">
          {session.canTypeDirectoryHook
            ? '경로 알림 없음 · Bash/Zsh에서 연결 가능'
            : '이 셸은 경로 알림을 지원하지 않습니다'}
          {session.canTypeDirectoryHook && (
            <button
              aria-label="셸 경로 알림 연결"
              disabled={state.status !== 'connected'}
              title="현재 셸의 프롬프트에 경로 알림을 추가합니다. 설정 파일은 변경하지 않습니다. 명령 실행 중에는 완료 후 누르세요."
              onClick={() => session.typeDirectoryHook()}
            >
              연결
            </button>
          )}
        </small>
      )}
    </>
  );
}
