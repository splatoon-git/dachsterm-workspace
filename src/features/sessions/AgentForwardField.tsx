import type { Profile } from '../../lib/ipc';
import { ForwardKeysField } from './ForwardKeysField';

/** Off by default. Only these checkboxes turn them on: a session file never carries them. */
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
      <div className="wide">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!profile.forwardGitCredentials}
            onChange={(e) => field('forwardGitCredentials', e.target.checked)}
          />
          HTTPS Git 자격 증명 전달
        </label>
        <p className="field-help">
          서버에서 https 저장소로 git push를 할 때 이 PC의 Git 자격 증명이나 앱에 저장한 토큰으로
          답합니다. 요청마다 허용할지 묻고, 허용한 값은 서버로 전달됩니다. 서버에는 아무것도
          설치하지 않습니다. 믿는 서버에서만 켜세요.
        </p>
      </div>
    </>
  );
}
