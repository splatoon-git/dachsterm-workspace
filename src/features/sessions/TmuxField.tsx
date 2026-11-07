import type { Profile } from '../../lib/ipc';

/** Keeps the form's own limits next to the only field that uses them. */
export function TmuxField({
  profile,
  field,
}: {
  profile: Profile;
  field: (key: 'tmuxSession', value: string) => void;
}) {
  return (
    <label className="wide">
      tmux 세션 이름 (선택)
      <input
        value={profile.tmuxSession ?? ''}
        maxLength={64}
        pattern="[A-Za-z0-9_\-]*"
        title="영문, 숫자, _, - 만 사용할 수 있습니다"
        placeholder="비워 두면 일반 셸로 시작합니다"
        onChange={(e) => field('tmuxSession', e.target.value)}
      />
      <small>
        서버의 tmux 세션에서 시작합니다. 연결이 끊겨도 실행 중인 작업이 서버에 남고, 재접속하면 같은
        화면으로 돌아옵니다. 서버에 tmux가 없으면 일반 셸로 시작합니다.
      </small>
    </label>
  );
}
