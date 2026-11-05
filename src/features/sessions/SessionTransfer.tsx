import { useState } from 'react';
import { call, desktop, errorText, type Profile, type Group } from '../../lib/ipc';
import './transfer.css';

type Bundle = {
  format?: string;
  version: number;
  profiles: Profile[];
  groups: Group[];
  tunnels: { profileId: string; [key: string]: unknown }[];
};
type Preview = { bundle: Bundle; warnings: string[]; skipped: number };

export function SessionTransfer({ changed }: { changed: () => void }) {
  const [format, setFormat] = useState('auto');
  const [encoding, setEncoding] = useState('utf-8');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function choose() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await call<Preview | null>('config_preview', { format, encoding });
      if (result) {
        setPreview(result);
        setSelected(result.bundle.profiles.map((p) => p.id));
      }
    } catch (e) {
      setError(errorText(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true);
    setError('');
    const profiles = preview.bundle.profiles.filter((p) => selected.includes(p.id));
    const bundle = {
      ...preview.bundle,
      profiles,
      groups: preview.bundle.groups.filter((g) => profiles.some((p) => p.groupId === g.id)),
      tunnels: preview.bundle.tunnels.filter((t) => selected.includes(t.profileId)),
    };
    try {
      const count = await call<number>('config_apply', { data: JSON.stringify(bundle) });
      setPreview(null);
      setSelected([]);
      setMessage(`${count}개 세션을 추가했습니다.`);
      changed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-data session-transfer" aria-label="세션 가져오기와 내보내기">
      <h3>세션 가져오기 · 내보내기</h3>
      <p className="muted">
        DaxTerm JSON으로 세션·그룹·터널을 보관합니다. PuTTY·MobaXterm·OpenSSH는 기본 SSH 접속 정보를
        변환합니다. 암호와 개인키 내용은 포함하지 않습니다.
      </p>
      <div className="transfer-options">
        <label>
          가져올 형식
          <select value={format} disabled={busy} onChange={(e) => setFormat(e.target.value)}>
            <option value="auto">자동 감지</option>
            <option value="daxterm">DaxTerm JSON (v1 / v2)</option>
            <option value="putty">PuTTY (.reg)</option>
            <option value="mobaxterm">MobaXterm (.mxtsessions / .ini)</option>
            <option value="openssh">OpenSSH (config)</option>
          </select>
        </label>
        <label>
          파일 문자 인코딩
          <select value={encoding} disabled={busy} onChange={(e) => setEncoding(e.target.value)}>
            <option value="utf-8">UTF-8 / UTF-16 BOM 자동</option>
            <option value="cp949">한국어 CP949</option>
            <option value="windows-1252">서유럽 Windows-1252</option>
          </select>
        </label>
      </div>
      <div className="form-actions">
        <button disabled={busy || !desktop} onClick={() => void choose()}>
          파일 선택 · 미리보기
        </button>
        <button
          disabled={busy || !desktop}
          onClick={async () => {
            setBusy(true);
            setError('');
            setMessage('');
            try {
              if (await call<boolean>('config_export'))
                setMessage('DaxTerm JSON 파일을 저장했습니다.');
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          JSON 내보내기
        </button>
      </div>
      {!desktop && (
        <p className="muted">파일 가져오기와 저장은 데스크톱 앱에서 사용할 수 있습니다.</p>
      )}
      {preview && (
        <div className="transfer-preview">
          <h4>
            변환 결과: {preview.bundle.profiles.length}개 · 제외 {preview.skipped}개
          </h4>
          {preview.warnings.length > 0 && (
            <ul>
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <p className="muted">
            기존 세션은 덮어쓰지 않고 새 ID로 추가합니다. 같은 파일을 다시 적용하면 사본이
            추가됩니다. 터널 자동 시작은 꺼지며, 키 경로는 해당 PC에서 다시 확인하세요.
          </p>
          <div className="form-actions">
            <button
              disabled={busy}
              onClick={() => setSelected(preview.bundle.profiles.map((p) => p.id))}
            >
              전체 선택
            </button>
            <button disabled={busy} onClick={() => setSelected([])}>
              선택 해제
            </button>
          </div>
          <div className="transfer-rows">
            {preview.bundle.profiles.map((p) => (
              <div className="transfer-row" key={p.id}>
                <label className="transfer-select">
                  <input
                    type="checkbox"
                    checked={selected.includes(p.id)}
                    disabled={busy}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, p.id]
                          : selected.filter((id) => id !== p.id),
                      )
                    }
                  />
                  <span>
                    {p.name}
                    <small>
                      {p.protocol} · {p.host}:{p.port}
                      {p.groupId
                        ? ` · ${preview.bundle.groups.find((g) => g.id === p.groupId)?.name ?? ''}`
                        : ''}
                    </small>
                  </span>
                </label>
                <label>
                  사용자명
                  <input
                    aria-label={`${p.name} 사용자명`}
                    value={p.username}
                    maxLength={256}
                    disabled={busy}
                    onChange={(e) =>
                      setPreview({
                        ...preview,
                        bundle: {
                          ...preview.bundle,
                          profiles: preview.bundle.profiles.map((item) =>
                            item.id === p.id ? { ...item, username: e.target.value } : item,
                          ),
                        },
                      })
                    }
                  />
                </label>
              </div>
            ))}
          </div>
          <div className="form-actions">
            <button
              disabled={busy}
              onClick={() => {
                setPreview(null);
                setSelected([]);
              }}
            >
              가져오기 취소
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                !selected.length ||
                preview.bundle.profiles.some((p) => selected.includes(p.id) && !p.username.trim())
              }
              onClick={() => void apply()}
            >
              {selected.length}개 세션 추가
            </button>
          </div>
        </div>
      )}
      {busy && <p role="status">처리 중…</p>}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
