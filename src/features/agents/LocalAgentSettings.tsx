import { KeyFileList } from '../../components/KeyFileList';
import { MAX_FORWARD_KEYS } from '../../components/keyFiles';
import { isMac } from '../../lib/platform';
import { useLocalAgent } from './useLocalAgent';

/** Whether local and WSL tabs get the app's agent, and its key files. */
export function LocalAgentSettings() {
  const { value, status, save } = useLocalAgent();
  return (
    <>
      <section className="dialog-section" aria-label="로컬 탭의 SSH 키">
        <h3>로컬 탭의 SSH 키</h3>
        <p>
          로컬 {isMac ? '' : '· WSL '}탭의 git과 ssh가 이 앱의 키를 쓰게 합니다. 앱의 키로 서명할
          때마다 그 탭에서 승인을 받습니다. 이 PC의 SSH agent에 등록된 키는 승인 없이 그대로 씁니다.
          바꾸면 새로 여는 탭부터 적용됩니다.
        </p>
        {value && (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={value.enabled}
                onChange={(e) => save({ ...value, enabled: e.target.checked }, '로컬')}
              />
              로컬 탭에 이 앱의 SSH 키 제공
            </label>
            <KeyFileList
              keys={value.keys}
              change={(keys) => save({ ...value, keys }, '로컬')}
              placeholder={isMac ? '예: ~/.ssh/id_ed25519' : '예: …\\.ssh\\id_ed25519'}
            />
            <small>
              최대 {MAX_FORWARD_KEYS}개. 암호화된 키의 Passphrase는 처음 서명을 허용할 때 묻습니다.
              {!isMac &&
                ' WSL에서는 git이 Windows의 ssh.exe를 거쳐 이 키를 씁니다. WSL 안에서 직접 실행하는 ssh는 원래 설정대로 동작합니다.'}
            </small>
          </>
        )}
        {status && <p role="status">{status}</p>}
      </section>
    </>
  );
}
