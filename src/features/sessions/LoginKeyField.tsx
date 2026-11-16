import { NewSshKeyButton } from '../../components/NewSshKey';
import type { Profile } from '../../lib/ipc';

/** The private key a session logs in with (a path, or a key made on the spot) and its optional
 *  OpenSSH certificate. Without one, `<key>-cert.pub` next to the key is used when it exists. */
export function LoginKeyField({
  profile,
  field,
}: {
  profile: Profile;
  field: (key: 'keyPath' | 'certPath', value: string) => void;
}) {
  return (
    <>
      <div className="wide login-key-field">
        <label>
          개인키 파일 경로
          <input
            required
            placeholder="C:\Users\…\.ssh\id_ed25519"
            value={profile.keyPath}
            onChange={(e) => field('keyPath', e.target.value)}
          />
        </label>
        <NewSshKeyButton created={(key) => field('keyPath', key.path)} />
      </div>
      <label className="wide">
        인증서 파일 경로 (선택)
        <input
          maxLength={4096}
          placeholder="비워 두면 개인키 옆의 -cert.pub 파일을 씁니다"
          value={profile.certPath ?? ''}
          onChange={(e) => field('certPath', e.target.value)}
        />
        <small>
          연결 전에 인증서의 유효 기간과 개인키 짝을 확인합니다. 지정한 인증서가 맞지 않으면
          연결하지 않습니다.
        </small>
      </label>
    </>
  );
}
