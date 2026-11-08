import { useEffect, useState } from 'react';
import { call, desktop, errorText } from '../../lib/ipc';
import './agents.css';

type Saved = { host: string; username: string };

/**
 * HTTPS Git credentials saved from the card. Only host and user are listed: the values stay in
 * the OS store or the vault. Removing one also removes the stored value.
 */
export function GitCredentialSettings() {
  // Outside the app nothing is saved, and the list starts empty.
  const [saved, setSaved] = useState<Saved[] | null>(desktop ? null : []);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!desktop) return;
    call<Saved[]>('git_credentials_saved')
      .then(setSaved)
      .catch((e) => {
        setSaved([]);
        setStatus(errorText(e));
      });
  }, []);
  async function forget(entry: Saved) {
    try {
      await call('git_credential_forget', { ...entry });
      setSaved((list) => list?.filter((e) => e !== entry) ?? null);
      setStatus('');
    } catch (e) {
      setStatus(errorText(e));
    }
  }
  return (
    <section className="dialog-section" aria-label="저장한 Git 자격 증명">
      <h3>저장한 Git 자격 증명</h3>
      <p>
        HTTPS Git 자격 증명 요청 카드에서 직접 입력하고 &lsquo;이 PC에 저장&rsquo;한 토큰입니다.
        서버에서 git이 물을 때 이 PC의 Git 자격 증명 관리자보다 먼저 씁니다.
      </p>
      {saved?.length === 0 && <p className="field-help">저장한 자격 증명이 없습니다.</p>}
      {saved && saved.length > 0 && (
        <ul className="git-credentials">
          {saved.map((entry) => (
            <li key={`${entry.host}\n${entry.username}`}>
              <span>
                <code>https://{entry.host}</code> · {entry.username}
              </span>
              <button
                type="button"
                aria-label={`${entry.host} ${entry.username} 삭제`}
                title="삭제"
                onClick={() => void forget(entry)}
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
      {status && <p role="alert">{status}</p>}
    </section>
  );
}
