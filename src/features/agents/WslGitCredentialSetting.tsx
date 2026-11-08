import { isMac } from '../../lib/platform';
import { useLocalAgent } from './useLocalAgent';

/** Whether WSL tabs get HTTPS Git credentials from this PC. WSL exists on Windows only. */
export function WslGitCredentialSetting() {
  const { value, status, save } = useLocalAgent();
  if (isMac || !value) return null;
  return (
    <section className="dialog-section" aria-label="WSL 탭의 HTTPS Git 자격 증명">
      <h3>WSL 탭의 HTTPS Git 자격 증명</h3>
      <p>
        WSL 안의 git이 https 저장소의 자격 증명을 물으면 이 PC의 Git 자격 증명 관리자나 앱에 저장한
        토큰으로 답합니다. 요청마다 그 탭에서 승인을 받고, 값이 없으면 직접 입력할 수 있습니다.
        바꾸면 새로 여는 WSL 탭부터 적용됩니다.
      </p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={value.wslGitCredentials}
          onChange={(e) => save({ ...value, wslGitCredentials: e.target.checked }, 'WSL')}
        />
        WSL 탭에 이 PC의 HTTPS Git 자격 증명 제공
      </label>
      {status && <p role="status">{status}</p>}
    </section>
  );
}
