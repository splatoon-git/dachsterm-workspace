import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dialog } from '../../components/Dialog';
import { call, errorText } from '../../lib/ipc';
import type { TerminalSession } from './session';
import {
  emptySnippet,
  expand,
  matchesSnippet,
  variables,
  type Library,
  type Snippet,
} from './snippets';
import { needsPasteConfirmation } from './preferences';
import './assistant.css';
type Preview = {
  body: string;
  execute: boolean;
  targets: { session: TerminalSession; id: string; name: string; bracketed: boolean }[];
};
function TargetRow({
  session,
  selected,
  toggle,
}: {
  session: TerminalSession;
  selected: boolean;
  toggle: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={selected}
        disabled={state.status !== 'connected' || !!state.authPrompt || state.replaying}
        onChange={toggle}
      />
      {session.profile.name} ·{' '}
      {session.localTarget?.name ??
        `${session.profile.username}@${session.profile.host}:${session.profile.port}`}{' '}
      · {state.status}
    </label>
  );
}
export function SnippetDialog({
  sessions,
  active,
  close,
}: {
  sessions: TerminalSession[];
  active?: string;
  close: () => void;
}) {
  const [library, setLibrary] = useState<Library | null>(null);
  const [draft, setDraft] = useState<Snippet>(emptySnippet);
  const [query, setQuery] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>(active ? [active] : []);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [noSecrets, setNoSecrets] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const sending = useRef(false);
  const candidates = sessions.filter((s) => !s.podtree && s.profile.protocol === 'ssh');
  const load = () =>
    call<Library>('snippet_list')
      .then(setLibrary)
      .catch((e) => setMessage(errorText(e)));
  useEffect(() => {
    void load();
  }, []);
  function edit(s: Snippet) {
    setDraft({ ...s });
    setValues({});
    setNoSecrets(false);
    setPreview(null);
    setDeleting(false);
    setMessage('');
  }
  async function save(items: Snippet[]) {
    if (!library) return;
    setBusy(true);
    try {
      setLibrary(await call<Library>('snippet_save', { revision: library.revision, items }));
      setMessage('저장했습니다.');
      setDeleting(false);
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function review(execute: boolean) {
    try {
      const body = expand(draft.body, values);
      if (!body.trim() || new TextEncoder().encode(body).length > 16384)
        throw new Error('명령은 비어 있지 않은 16KiB 이하 본문이어야 합니다.');
      if (
        Array.from(body).some(
          (c) => (c.charCodeAt(0) < 32 && !'\t\n\r'.includes(c)) || c.charCodeAt(0) === 127,
        )
      )
        throw new Error('Tab·줄바꿈 이외 제어문자는 보낼 수 없습니다.');
      const targets = candidates.filter((s) => selected.includes(s.tabId));
      if (!targets.length || targets.length > 32)
        throw new Error('연결된 대상 1~32개를 선택하세요.');
      if (
        targets.some(
          (s) =>
            s.snapshot().status !== 'connected' ||
            s.snapshot().authPrompt ||
            s.snapshot().replaying,
        )
      )
        throw new Error('연결/인증 상태가 바뀌었습니다. 대상을 다시 확인하세요.');
      setPreview({
        body,
        execute,
        targets: targets.map((s) => ({
          session: s,
          id: s.connectionId,
          name: s.profile.name,
          bracketed: s.terminal.modes.bracketedPasteMode,
        })),
      });
      setConfirmed(false);
      setMessage('');
    } catch (e) {
      setMessage(errorText(e));
    }
  }
  async function send() {
    if (!preview || sending.current) return;
    const reviewed = preview;
    // Check the exact objects and connection identities again after user review.
    if (
      reviewed.targets.some(
        (t) =>
          !sessions.includes(t.session) ||
          t.id !== t.session.connectionId ||
          t.session.snapshot().status !== 'connected' ||
          t.session.snapshot().authPrompt ||
          t.session.snapshot().replaying ||
          t.bracketed !== t.session.terminal.modes.bracketedPasteMode,
      )
    ) {
      setPreview(null);
      setMessage(
        '연결 또는 붙여넣기 모드가 바뀌었습니다. 대상을 다시 선택하고 미리보기를 확인하세요.',
      );
      return;
    }
    sending.current = true;
    setBusy(true);
    setPreview(null);
    try {
      const results = await call<{ id: string; error: string | null }[]>('snippet_send', {
        targets: reviewed.targets.map((t) => ({ id: t.id, bracketed: t.bracketed })),
        body: reviewed.body,
        execute: reviewed.execute,
      });
      setMessage(
        results
          .map(
            (r) =>
              `${reviewed.targets.find((t) => t.id === r.id)?.name}: ${r.error ?? '입력 전달됨'}`,
          )
          .join('\n') + '\n원격 명령 성공 여부는 터미널에서 확인하세요.',
      );
      setValues({});
    } catch {
      setMessage(
        '전달 결과를 확인하지 못했습니다. 중복 실행을 막기 위해 터미널을 확인한 뒤 다시 시도하세요.',
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="스니펫"
      close={() => {
        if (!busy) close();
      }}
      className="assistant-dialog"
    >
      <p className="muted">
        자주 쓰는 명령을 로컬에 저장합니다. 비밀번호·개인키·Passphrase·OTP는 입력하거나 저장하지
        마세요. 자리표시자 {'{{경로}}'} 값은 저장하지 않습니다.
      </p>
      {message && (
        <p role="status" className="assistant-message">
          {message}
        </p>
      )}
      {preview ? (
        <div className="assistant-review">
          <h3>{preview.execute ? 'Enter를 포함해 실행' : '입력만 넣기'} · 최종 확인</h3>
          <ul>
            {preview.targets.map((t) => (
              <li key={t.id}>
                {t.name} ·{' '}
                {t.session.localTarget?.name ??
                  `${t.session.profile.username}@${t.session.profile.host}:${t.session.profile.port}`}{' '}
                · 연결 {t.id.slice(0, 8)}
              </li>
            ))}
          </ul>
          <pre>{preview.body}</pre>
          <p>
            현재 커서 위치에 전달합니다. 기존 입력을 지우지 않으며, 멀티 입력 그룹과 무관하게 위
            대상에만 한 번 보냅니다.
          </p>
          {needsPasteConfirmation(preview.body) && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              여러 줄/제어문자가 포함되어 입력만 넣어도 명령이 실행될 수 있음을 확인했습니다.
            </label>
          )}
          <div className="form-actions">
            <button onClick={() => setPreview(null)}>돌아가기</button>
            <button
              className="primary"
              disabled={busy || (needsPasteConfirmation(preview.body) && !confirmed)}
              onClick={() => void send()}
            >
              {preview.execute ? '확인 · 실행' : '확인 · 입력'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="assistant-grid">
            <section aria-label="저장된 스니펫">
              <input
                aria-label="스니펫 검색"
                placeholder="이름·그룹·태그·본문 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="form-actions">
                <button disabled={busy} onClick={() => edit(emptySnippet())}>
                  새 스니펫
                </button>
                <button disabled={busy} onClick={() => void load()}>
                  다시 불러오기
                </button>
              </div>
              <div className="snippet-list">
                {library?.items
                  .filter((s) => matchesSnippet(s, query))
                  .map((s) => (
                    <button key={s.id} aria-pressed={draft.id === s.id} onClick={() => edit(s)}>
                      {s.name}
                      <small>
                        {s.group} {s.tags}
                      </small>
                    </button>
                  ))}
                {library?.items.length === 0 && <p>저장된 스니펫이 없습니다.</p>}
              </div>
            </section>
            <section className="snippet-editor" aria-label="스니펫 편집">
              {(['name', 'description', 'group', 'tags'] as const).map((key, i) => (
                <label key={key}>
                  {['이름', '설명', '그룹', '태그'][i]}
                  <input
                    value={draft[key]}
                    maxLength={key === 'description' ? 1000 : 200}
                    onChange={(e) => {
                      setDraft({ ...draft, [key]: e.target.value });
                      setNoSecrets(false);
                    }}
                  />
                </label>
              ))}
              <label>
                명령 본문
                <textarea
                  aria-label="명령 본문"
                  rows={5}
                  value={draft.body}
                  maxLength={16384}
                  spellCheck={false}
                  onChange={(e) => {
                    setDraft({ ...draft, body: e.target.value });
                    setValues({});
                    setNoSecrets(false);
                  }}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={noSecrets}
                  onChange={(e) => setNoSecrets(e.target.checked)}
                />
                저장 내용에 인증정보가 없습니다.
              </label>
              <div className="form-actions">
                <button
                  disabled={
                    busy || !library || !noSecrets || !draft.name.trim() || !draft.body.trim()
                  }
                  onClick={() =>
                    void save([...(library?.items.filter((s) => s.id !== draft.id) ?? []), draft])
                  }
                >
                  저장
                </button>
                <button
                  disabled={busy || !draft.name}
                  onClick={() =>
                    edit({ ...draft, id: crypto.randomUUID(), name: `${draft.name} 복사` })
                  }
                >
                  복제
                </button>
                <button
                  disabled={busy || !library?.items.some((s) => s.id === draft.id)}
                  onClick={() => setDeleting(true)}
                >
                  삭제
                </button>
              </div>
              {deleting && (
                <div role="alert">
                  <p>저장된 “{draft.name}”을 삭제할까요?</p>
                  <button onClick={() => setDeleting(false)}>취소</button>
                  <button
                    onClick={() => void save(library!.items.filter((s) => s.id !== draft.id))}
                  >
                    삭제 확인
                  </button>
                </div>
              )}
            </section>
          </div>
          <fieldset>
            <legend>이번 입력 값 · 저장하지 않음</legend>
            <p className="muted">
              값을 문자 그대로 치환합니다. 셸 인용/이스케이프를 자동 적용하지 않으므로 최종 명령을
              확인하세요.
            </p>
            {variables(draft.body).map((name) => (
              <label key={name}>
                {name}
                <input
                  autoComplete="off"
                  value={values[name] ?? ''}
                  onChange={(e) => setValues({ ...values, [name]: e.target.value })}
                />
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>전달할 터미널 · 현재 창</legend>
            {candidates.map((s) => (
              <TargetRow
                key={s.tabId}
                session={s}
                selected={selected.includes(s.tabId)}
                toggle={() =>
                  setSelected((old) =>
                    old.includes(s.tabId) ? old.filter((id) => id !== s.tabId) : [...old, s.tabId],
                  )
                }
              />
            ))}
            {!candidates.length && <p>SSH·로컬·WSL 터미널을 먼저 연결하세요.</p>}
          </fieldset>
          <div className="form-actions">
            <button disabled={busy} onClick={() => review(false)}>
              입력만 넣기 · 미리보기
            </button>
            <button disabled={busy} onClick={() => review(true)}>
              Enter 포함 실행 · 미리보기
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
