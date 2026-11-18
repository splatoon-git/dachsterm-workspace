import type { Profile } from '../../lib/ipc';
import { needsUsername } from './protocol';

/**
 * Where a network session goes and how it logs in. A serial session has a device instead
 * (`SerialFields`).
 */
export function NetworkFields({
  profile,
  field,
  secretChanged,
}: {
  profile: Profile;
  field: <K extends keyof Profile>(key: K, value: Profile[K]) => void;
  /** The login method changed, so a typed secret is cleared; `forget` drops a saved one too. */
  secretChanged: (forget: boolean) => void;
}) {
  return (
    <>
      <label>
        호스트
        <input
          required
          maxLength={253}
          placeholder="server.example.com"
          value={profile.host}
          onChange={(e) => field('host', e.target.value.trim())}
        />
      </label>
      <label>
        포트
        <input
          required
          type="number"
          min={1}
          max={65535}
          value={profile.port}
          onChange={(e) => field('port', Number(e.target.value))}
        />
      </label>
      {/* Telnet has no login method to choose, so the name takes the whole row. */}
      <label className={profile.protocol === 'telnet' ? 'wide' : undefined}>
        사용자
        <input
          required={needsUsername(profile)}
          placeholder={(profile.protocol ?? 'ssh') === 'ssh' ? '비우면 연결할 때 묻습니다' : ''}
          maxLength={256}
          value={profile.username}
          onChange={(e) => field('username', e.target.value)}
        />
      </label>
      {profile.protocol !== 'telnet' && (
        <label>
          인증 방식
          <select
            aria-label="인증 방식"
            disabled={!!profile.protocol && profile.protocol !== 'ssh'}
            value={profile.auth}
            onChange={(e) => {
              field('auth', e.target.value as Profile['auth']);
              secretChanged(['agent', 'interactive'].includes(e.target.value));
            }}
          >
            <option value="password">비밀번호</option>
            <option value="key">개인키</option>
            <option value="agent">SSH agent · OS 인증 에이전트</option>
            <option value="interactive">서버 질문 · OTP / MFA</option>
          </select>
        </label>
      )}
    </>
  );
}
