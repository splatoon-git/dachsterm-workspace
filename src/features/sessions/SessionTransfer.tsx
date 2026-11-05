import { useState } from 'react';
import { call, desktop, errorText, type Profile, type Group } from '../../lib/ipc';
import './transfer.css';
import { importSelection, routeNames } from './model';
import type { SessionTemplate } from './SessionManager';

type Bundle = {
  format?: string;
  version: number;
  profiles: Profile[];
  groups: Group[];
  tunnels: { profileId: string; [key: string]: unknown }[];
  templates?: SessionTemplate[];
};
type Preview = {
  bundle: Bundle;
  warnings: string[];
  skipped: number;
  includePlan?: { token: string; files: string[] } | null;
};

export function SessionTransfer({
  changed,
  profiles: existing = [],
}: {
  changed: () => void;
  profiles?: Profile[];
}) {
  const [merges, setMerges] = useState<Record<string, string>>({});
  const [includeFiles, setIncludeFiles] = useState<string[]>([]);
  const [format, setFormat] = useState('auto');
  const [encoding, setEncoding] = useState('utf-8');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const effective = preview
    ? importSelection(preview.bundle, [
        ...selected,
        ...(preview.bundle.templates ?? []).flatMap((t) => t.options.jumpIds ?? []),
      ])
    : null;
  async function choose() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await call<Preview | null>('config_preview', { format, encoding });
      if (result) {
        setPreview(result);
        setMerges({});
        setIncludeFiles([]);
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
    if (!preview || !effective) return;
    setBusy(true);
    setError('');
    // Template references are included alongside selected route dependencies.
    const bundle = effective;
    try {
      const count = await call<number>('config_apply', {
        data: JSON.stringify(bundle),
        merges: Object.entries(merges)
          .filter(([id, target]) => target && bundle.profiles.some((p) => p.id === id))
          .map(([sourceId, target]) => ({
            sourceId,
            expected: existing.find((p) => p.id === target),
          })),
      });
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
        DaxTerm JSON으로 세션·계층·태그·경유·템플릿·터널을 보관합니다. 외부 형식의 지원·제외 필드는
        변환 보고서에서 확인하세요. 암호와 개인키 내용은 포함하지 않습니다.
      </p>
      <div className="transfer-options">
        <label>
          가져올 형식
          <select value={format} disabled={busy} onChange={(e) => setFormat(e.target.value)}>
            <option value="auto">자동 감지</option>
            <option value="daxterm">DaxTerm JSON (v1 / v2 / v3)</option>
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
          {preview.includePlan && (
            <fieldset>
              <legend>Include 파일 읽기 승인</legend>
              <p>
                선택한 설정 루트의 파일 목록입니다. 필요한 설정 파일만 선택하세요. 중첩 Include도
                승인한 파일만 읽습니다.
              </p>
              {preview.includePlan.files.map((f) => (
                <label className="checkbox" key={f}>
                  <input
                    type="checkbox"
                    checked={includeFiles.includes(f)}
                    onChange={(e) =>
                      setIncludeFiles(
                        e.target.checked
                          ? [...includeFiles, f]
                          : includeFiles.filter((v) => v !== f),
                      )
                    }
                  />
                  {f}
                </label>
              ))}
              <button
                disabled={busy || !includeFiles.length}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    const next = await call<Preview>('config_include_preview', {
                      token: preview.includePlan!.token,
                      files: includeFiles,
                    });
                    setPreview(next);
                    setSelected(next.bundle.profiles.map((p) => p.id));
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                선택한 Include 읽기 · 변환 미리보기
              </button>
            </fieldset>
          )}
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
            기본은 새 ID로 추가합니다. 동일 접속 대상은 명시적으로 병합할 수 있습니다. 선택한 세션의
            경유지·상위 그룹·템플릿 참조도 함께 가져옵니다. 터널 자동 시작은 꺼지며, 키 경로는 해당
            PC에서 다시 확인하세요.
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
                    checked={effective?.profiles.some((v) => v.id === p.id) ?? false}
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
                    {!selected.includes(p.id) && effective?.profiles.some((v) => v.id === p.id) && (
                      <small>선택한 세션/템플릿에 필요한 경유지 · 함께 가져옴</small>
                    )}
                    <small>
                      {p.protocol} · {p.host}:{p.port}
                      {p.groupId
                        ? ` · ${preview.bundle.groups.find((g) => g.id === p.groupId)?.name ?? ''}`
                        : ''}
                    </small>
                  </span>
                </label>
                <p className="muted">{routeNames(p, preview.bundle.profiles).join(' → ')}</p>
                <label>
                  충돌 처리
                  <select
                    value={merges[p.id] ?? ''}
                    onChange={(e) => setMerges({ ...merges, [p.id]: e.target.value })}
                  >
                    <option value="">새 ID로 추가</option>
                    {existing
                      .filter(
                        (v) =>
                          v.protocol === p.protocol &&
                          v.host === p.host &&
                          v.port === p.port &&
                          v.username === p.username &&
                          v.auth === p.auth &&
                          v.keyPath === p.keyPath &&
                          v.tlsCaPath === p.tlsCaPath,
                      )
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}에 병합 · 이름/그룹/태그/연결 옵션 교체
                        </option>
                      ))}
                  </select>
                  <small>
                    선택 해제하면 건너뜁니다. 필수 경유 참조는 포함됩니다. 병합은 동일
                    프로토콜·호스트·포트·계정·인증·키·CA 기준이며 저장 암호를 유지합니다.
                  </small>
                </label>
                {merges[p.id] && (
                  <ul className="muted" aria-label={`${p.name} 병합 변경 필드`}>
                    {(
                      [
                        ['name', '이름'],
                        ['groupId', '그룹'],
                        ['tags', '태그'],
                        ['jumpIds', '경유 참조'],
                        ['encoding', '인코딩'],
                        ['timeout', '타임아웃'],
                        ['keepalive', 'KeepAlive'],
                        ['favorite', '즐겨찾기'],
                        ['sortOrder', '정렬 순서'],
                      ] as const
                    ).map(([key, label]) => (
                      <li key={key}>
                        {label}:{' '}
                        {JSON.stringify(existing.find((v) => v.id === merges[p.id])?.[key] ?? null)}{' '}
                        → {JSON.stringify(p[key] ?? null)}
                      </li>
                    ))}
                  </ul>
                )}
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
                (!effective?.profiles.length && !preview.bundle.templates?.length) ||
                effective?.profiles.some((p) => !p.username.trim())
              }
              onClick={() => void apply()}
            >
              {effective?.profiles.length ?? 0}개 세션 추가
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
