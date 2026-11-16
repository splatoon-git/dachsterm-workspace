import type { Profile } from '../../lib/ipc';

/** What `agent` and `interactive` logins mean, and which agent signs (CG.3). */
export function AgentLoginField({
  profile,
  field,
}: {
  profile: Profile;
  field: (key: 'agentSource', value: Profile['agentSource']) => void;
}) {
  return (
    <>
      {profile.auth === 'agent' && (
        <label className="wide">
          인증 에이전트
          <select
            aria-label="인증 에이전트"
            value={profile.agentSource ?? 'system'}
            onChange={(e) => field('agentSource', e.target.value as Profile['agentSource'])}
          >
            <option value="system">OpenSSH ssh-agent</option>
            <option value="pageant">Pageant · Windows 전용</option>
          </select>
          <small>SSH 키 전달도 같은 에이전트를 씁니다.</small>
        </label>
      )}
      <p className="muted wide">
        에이전트는 등록된 키로 서명하며 개인키를 앱에 저장하지 않습니다. 서버의 OTP·추가 인증 질문은
        연결 중 표시되고 응답은 저장하지 않습니다. 키 인증 뒤 추가 MFA도 자동으로 표시합니다.
      </p>
    </>
  );
}
