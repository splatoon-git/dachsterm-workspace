import { KeyFileList } from '../../components/KeyFileList';
import { MAX_FORWARD_KEYS } from '../../components/keyFiles';
import type { Profile } from '../../lib/ipc';

type Field = <K extends keyof Profile>(key: K, value: Profile[K]) => void;

/** Which keys the built-in agent offers on this session (DX.11). Shown under the forwarding option. */
export function ForwardKeysField({ profile, field }: { profile: Profile; field: Field }) {
  return (
    <fieldset className="wide forward-keys">
      <legend>전달할 키</legend>
      {profile.auth === 'key' && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={profile.forwardLoginKey ?? true}
            onChange={(e) => field('forwardLoginKey', e.target.checked)}
          />
          로그인 키 (위의 개인키 파일)
        </label>
      )}
      <KeyFileList
        keys={profile.forwardKeys ?? []}
        change={(keys) => field('forwardKeys', keys)}
        placeholder="예: Git 호스팅에 등록한 키 · …\.ssh\id_git"
      />
      <label className="checkbox">
        <input
          type="checkbox"
          checked={profile.forwardSystemAgent ?? true}
          onChange={(e) => field('forwardSystemAgent', e.target.checked)}
        />
        이 PC의 SSH agent 키도 사용
      </label>
      <small>
        서버에는 공개키만 보이고, 개인키는 이 PC에서 서명할 때만 씁니다. 최대 {MAX_FORWARD_KEYS}개.
        암호화된 키의 Passphrase는 처음 서명을 허용할 때 묻습니다. 이 PC의 SSH agent가 없으면 조용히
        건너뜁니다.
      </small>
    </fieldset>
  );
}
