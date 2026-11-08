import { useEffect, useRef, useState } from 'react';
import { KeyFileList } from '../../components/KeyFileList';
import { MAX_FORWARD_KEYS } from '../../components/keyFiles';
import { call, errorText, type ForwardKey } from '../../lib/ipc';
import { isMac } from '../../lib/platform';

/** `local_agent_settings`: app-wide, since local tabs have no session (DX.13). */
export type LocalAgent = { enabled: boolean; keys: ForwardKey[] };

/**
 * Whether local and WSL tabs get the app's agent, and its key files. Saves as it changes, one save
 * at a time in order; only the latest answer replaces what is shown.
 */
export function LocalAgentSettings() {
  const [value, setValue] = useState<LocalAgent | null>(null);
  const [status, setStatus] = useState('');
  const queue = useRef(Promise.resolve());
  const latest = useRef(0);
  useEffect(() => {
    call<LocalAgent>('local_agent_settings').then(setValue, (e: unknown) =>
      setStatus(errorText(e)),
    );
  }, []);
  function save(next: LocalAgent) {
    setValue(next);
    const turn = ++latest.current;
    queue.current = queue.current.then(() =>
      call<LocalAgent>('local_agent_save', {
        enabled: next.enabled,
        keys: next.keys.map((key) => key.path),
      }).then(
        (saved) => {
          if (turn !== latest.current) return;
          setValue(saved);
          setStatus('저장했습니다. 새로 여는 로컬 탭부터 적용됩니다.');
        },
        (e: unknown) => setStatus(errorText(e)),
      ),
    );
  }
  return (
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
      {status && <p role="status">{status}</p>}
    </section>
  );
}
