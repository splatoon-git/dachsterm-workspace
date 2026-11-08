import type { Profile } from '../../lib/ipc';
import { ForwardKeysField } from './ForwardKeysField';

/** Off by default. Only this checkbox turns it on: a session file never carries it. */
export function AgentForwardField({
  profile,
  field,
}: {
  profile: Profile;
  field: <K extends keyof Profile>(key: K, value: Profile[K]) => void;
}) {
  return (
    <>
      <div className="wide">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!profile.forwardAgent}
            onChange={(e) => field('forwardAgent', e.target.checked)}
          />
          SSH 키 전달 (agent forwarding)
        </label>
        <p className="field-help">
          서버에서 이 PC의 SSH 키로 서명할 수 있게 합니다. 예를 들어 서버에서 git push를 할 때
          필요합니다. 서명할 때마다 허용할지 묻습니다. 서버 관리자나 서버에서 도는 프로그램도 서명을
          요청할 수 있으니 믿는 서버에서만 켜세요. 경유 서버에는 전달하지 않습니다.
        </p>
      </div>
      {profile.forwardAgent && <ForwardKeysField profile={profile} field={field} />}
    </>
  );
}
