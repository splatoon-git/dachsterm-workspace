import { useEffect, useRef, useState } from 'react';
import { KeyFileList } from '../../components/KeyFileList';
import { MAX_FORWARD_KEYS } from '../../components/keyFiles';
import { call, errorText, type ForwardKey } from '../../lib/ipc';
import { isMac } from '../../lib/platform';

/**
 * `local_agent_settings`: app-wide, since local tabs have no session (DX.13). `wslGitCredentials`
 * lets WSL tabs ask this PC for HTTPS Git credentials (DX.14).
 */
export type LocalAgent = { enabled: boolean; keys: ForwardKey[]; wslGitCredentials: boolean };

/**
 * Whether local and WSL tabs get the app's agent, and its key files, and on Windows whether WSL
 * tabs get HTTPS Git credentials. Saves as it changes, one save at a time in order; only the
 * latest answer replaces what is shown.
 */
export function LocalAgentSettings() {
  const [value, setValue] = useState<LocalAgent | null>(null);
  // Shown under the part that was changed last.
  const [status, setStatus] = useState({ text: '', wsl: false });
  const queue = useRef(Promise.resolve());
  const latest = useRef(0);
  useEffect(() => {
    call<LocalAgent>('local_agent_settings').then(setValue, (e: unknown) =>
      setStatus({ text: errorText(e), wsl: false }),
    );
  }, []);
  function save(next: LocalAgent, wsl = false) {
    setValue(next);
    const turn = ++latest.current;
    queue.current = queue.current.then(() =>
      call<LocalAgent>('local_agent_save', {
        enabled: next.enabled,
        keys: next.keys.map((key) => key.path),
        wslGitCredentials: next.wslGitCredentials,
      }).then(
        (saved) => {
          if (turn !== latest.current) return;
          setValue(saved);
          const tabs = wsl ? 'WSL' : '로컬';
          setStatus({ text: `저장했습니다. 새로 여는 ${tabs} 탭부터 적용됩니다.`, wsl });
        },
        (e: unknown) => setStatus({ text: errorText(e), wsl }),
      ),
    );
  }
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
                onChange={(e) => save({ ...value, enabled: e.target.checked })}
              />
              로컬 탭에 이 앱의 SSH 키 제공
            </label>
            <KeyFileList
              keys={value.keys}
              change={(keys) => save({ ...value, keys })}
              placeholder={isMac ? '예: ~/.ssh/id_ed25519' : '예: …\\.ssh\\id_ed25519'}
            />
            <small>
              최대 {MAX_FORWARD_KEYS}개. 암호화된 키의 Passphrase는 처음 서명을 허용할 때 묻습니다.
              {!isMac &&
                ' WSL에서는 git이 Windows의 ssh.exe를 거쳐 이 키를 씁니다. WSL 안에서 직접 실행하는 ssh는 원래 설정대로 동작합니다.'}
            </small>
          </>
        )}
        {status.text && !status.wsl && <p role="status">{status.text}</p>}
      </section>
      {/* WSL exists on Windows only. */}
      {!isMac && value && (
        <section className="dialog-section" aria-label="WSL 탭의 HTTPS Git 자격 증명">
          <h3>WSL 탭의 HTTPS Git 자격 증명</h3>
          <p>
            WSL 안의 git이 https 저장소의 자격 증명을 물으면 이 PC의 Git 자격 증명 관리자나 앱에
            저장한 토큰으로 답합니다. 요청마다 그 탭에서 승인을 받고, 값이 없으면 직접 입력할 수
            있습니다. 바꾸면 새로 여는 WSL 탭부터 적용됩니다.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={value.wslGitCredentials}
              onChange={(e) => save({ ...value, wslGitCredentials: e.target.checked }, true)}
            />
            WSL 탭에 이 PC의 HTTPS Git 자격 증명 제공
          </label>
          {status.text && status.wsl && <p role="status">{status.text}</p>}
        </section>
      )}
    </>
  );
}
