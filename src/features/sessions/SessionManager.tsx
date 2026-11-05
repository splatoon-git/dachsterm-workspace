import { useEffect, useState } from 'react';
import { blankProfile, call, errorText, type Profile, type Snapshot } from '../../lib/ipc';
import { groupPath, matchesSession } from './model';
import { JumpEditor } from './JumpEditor';

export type SessionOptions = Partial<
  Pick<
    Profile,
    | 'port'
    | 'auth'
    | 'keyPath'
    | 'encoding'
    | 'timeout'
    | 'keepalive'
    | 'jumpIds'
    | 'tags'
    | 'favorite'
    | 'sortOrder'
  >
> & { groupId?: string };
export type SessionTemplate = { id: string; name: string; options: SessionOptions };
const labels: Record<keyof SessionOptions, string> = {
  port: '포트',
  auth: '인증 방식',
  keyPath: '개인키 경로',
  encoding: '인코딩',
  timeout: '타임아웃',
  keepalive: 'KeepAlive',
  jumpIds: '경유 관계',
  tags: '태그',
  favorite: '즐겨찾기',
  sortOrder: '정렬 순서',
  groupId: '그룹',
};
export function SessionManager({ snapshot, changed }: { snapshot: Snapshot; changed: () => void }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [options, setOptions] = useState<SessionOptions>({});
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<{ expected: Profile[]; options: SessionOptions } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    call<SessionTemplate[]>('session_templates')
      .then(setTemplates)
      .catch((e) => setMessage(errorText(e)));
  }, []);
  const visible = snapshot.profiles.filter((p) => matchesSession(p, query, snapshot.groups));
  const base = { ...blankProfile(), ...options };
  function field<K extends keyof SessionOptions>(key: K, value: SessionOptions[K]) {
    setOptions((o) => ({ ...o, [key]: value }));
    setPreview(null);
  }
  async function apply() {
    if (!preview) return;
    setBusy(true);
    try {
      const count = await call<number>('session_batch', preview);
      setMessage(`${count}개 변경 완료 · 변경 전 복구본 저장됨`);
      setPreview(null);
      changed();
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveTemplate(template: SessionTemplate, remove = false) {
    setBusy(true);
    try {
      await call('template_save', { template, remove });
      setTemplates(await call<SessionTemplate[]>('session_templates'));
      setMessage(remove ? '템플릿 삭제됨' : '템플릿 저장됨');
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-data session-transfer" aria-label="고급 세션 관리">
      <h3>세션 일괄 수정 · 템플릿</h3>
      <p className="muted">
        공백으로 조건을 함께 검색합니다. 예: tag:운영 host:db group:서울. 선택한 필드만 변경하며
        비밀정보는 복제하지 않습니다.
      </p>
      <label>
        관리 대상 검색
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="form-actions">
        <button
          disabled={busy}
          onClick={() => {
            setSelected(visible.map((p) => p.id));
            setPreview(null);
          }}
        >
          검색 결과 전체 선택
        </button>
        <button
          onClick={() => {
            setSelected([]);
            setPreview(null);
          }}
        >
          선택 해제
        </button>
      </div>
      <div className="transfer-rows">
        {visible.map((p) => (
          <label className="checkbox" key={p.id}>
            <input
              type="checkbox"
              checked={selected.includes(p.id)}
              onChange={(e) => {
                setSelected(
                  e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id),
                );
                setPreview(null);
              }}
            />
            {p.name} · {p.username}@{p.host}:{p.port} · {groupPath(p.groupId, snapshot.groups)}
          </label>
        ))}
      </div>
      <label>
        템플릿 불러오기
        <select
          value=""
          onChange={(e) => {
            const t = templates.find((t) => t.id === e.target.value);
            if (t) {
              setOptions(t.options);
              setPreview(null);
            }
          }}
        >
          <option value="">템플릿 선택</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <div className="form-grid">
        {(Object.keys(labels) as (keyof SessionOptions)[]).map((key) => (
          <fieldset key={key} className={key === 'jumpIds' ? 'wide' : undefined}>
            <legend>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={options[key] !== undefined && options[key] !== null}
                  onChange={(e) => {
                    if (e.target.checked) field(key, key === 'groupId' ? '' : (base[key] ?? []));
                    else {
                      setOptions((o) => {
                        const next = { ...o };
                        delete next[key];
                        return next;
                      });
                      setPreview(null);
                    }
                  }}
                />
                {labels[key]} 변경
              </label>
            </legend>
            {options[key] !== undefined &&
              options[key] !== null &&
              (key === 'jumpIds' ? (
                <JumpEditor
                  profile={base}
                  profiles={snapshot.profiles}
                  change={(ids) => field('jumpIds', ids)}
                />
              ) : key === 'groupId' ? (
                <select
                  aria-label="일괄 그룹"
                  value={options.groupId}
                  onChange={(e) => field(key, e.target.value)}
                >
                  <option value="">그룹 없음</option>
                  {snapshot.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {groupPath(g.id, snapshot.groups)}
                    </option>
                  ))}
                </select>
              ) : key === 'auth' ? (
                <select
                  aria-label="일괄 인증"
                  value={options.auth}
                  onChange={(e) => field(key, e.target.value as Profile['auth'])}
                >
                  {['password', 'key', 'agent', 'interactive'].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              ) : key === 'favorite' ? (
                <input
                  aria-label="일괄 즐겨찾기"
                  type="checkbox"
                  checked={options.favorite}
                  onChange={(e) => field(key, e.target.checked)}
                />
              ) : (
                <input
                  aria-label={`일괄 ${labels[key]}`}
                  type={
                    ['port', 'timeout', 'keepalive', 'sortOrder'].includes(key) ? 'number' : 'text'
                  }
                  value={
                    key === 'tags' ? (options.tags ?? []).join(',') : String(options[key] ?? '')
                  }
                  onChange={(e) =>
                    field(
                      key,
                      key === 'tags'
                        ? e.target.value.split(',')
                        : ['port', 'timeout', 'keepalive', 'sortOrder'].includes(key)
                          ? Number(e.target.value)
                          : e.target.value,
                    )
                  }
                  onBlur={() => {
                    if (key === 'tags')
                      field('tags', (options.tags ?? []).map((v) => v.trim()).filter(Boolean));
                  }}
                />
              ))}
          </fieldset>
        ))}
      </div>
      <label>
        이 설정을 템플릿으로 저장
        <input
          value={name}
          maxLength={200}
          placeholder="템플릿 이름"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <button
        disabled={busy || !name.trim() || !Object.keys(options).length}
        onClick={() => void saveTemplate({ id: crypto.randomUUID(), name, options })}
      >
        새 템플릿 저장
      </button>
      <details>
        <summary>저장된 템플릿 관리</summary>
        {templates.map((t) => (
          <div key={t.id}>
            {t.name}
            <button disabled={busy} onClick={() => void saveTemplate(t, true)}>
              삭제
            </button>
          </div>
        ))}
      </details>
      <p className="muted">
        경유·포트·인증·키 설정은 다음 접속부터 적용됩니다. 저장 암호가 있는 세션의 인증 대상 변경은
        개별 편집에서 처리하세요.
      </p>
      <button
        disabled={busy || !selected.length || !Object.keys(options).length}
        onClick={() =>
          setPreview({
            expected: snapshot.profiles.filter((p) => selected.includes(p.id)),
            options: structuredClone(options),
          })
        }
      >
        변경 미리보기
      </button>
      {preview && (
        <div className="transfer-preview">
          <h4>{preview.expected.length}개 세션 변경 확인</h4>
          {preview.expected.map((p) => (
            <div key={p.id}>
              <strong>
                {p.name} · {p.host}
              </strong>
              <ul>
                {Object.entries(preview.options)
                  .filter(([, v]) => v !== null)
                  .map(([k, v]) => (
                    <li key={k}>
                      {labels[k as keyof SessionOptions]}:{' '}
                      {JSON.stringify(p[k as keyof Profile] ?? '')} → {JSON.stringify(v)}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
          <button disabled={busy} onClick={() => void apply()}>
            복구본 생성 후 일괄 적용
          </button>
          <button onClick={() => setPreview(null)}>취소</button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
