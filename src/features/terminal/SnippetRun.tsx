import { useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from '../../components/Icon';
import { call, errorText, UserError } from '../../lib/ipc';
import { checkedBody, previewParts } from './commandItems';
import { needsPasteConfirmation } from './preferences';
import type { TerminalSession } from './session';
import { expand, variables, type Snippet } from './snippets';

const ready = (s: TerminalSession) => {
  const state = s.snapshot();
  return state.status === 'connected' && !state.authPrompt && !state.replaying;
};
const address = (s: TerminalSession) =>
  s.localTarget?.name ?? `${s.profile.username}@${s.profile.host}:${s.profile.port}`;

/** One terminal the snippet can go to: a check box that follows the connection's state. */
function Target({
  session,
  selected,
  toggle,
}: {
  session: TerminalSession;
  selected: boolean;
  toggle: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const usable = state.status === 'connected' && !state.authPrompt && !state.replaying;
  return (
    <label className="cmd-target" title={address(session)}>
      <input type="checkbox" checked={selected} disabled={!usable} onChange={toggle} />
      <span className={`cmd-target-dot ${usable ? 'live' : ''}`} aria-hidden="true" />
      <span className="cmd-target-name">{session.profile.name}</span>
      {!usable && <small>{state.authPrompt ? '인증 대기' : '연결 안 됨'}</small>}
    </label>
  );
}

/**
 * A saved snippet ready to send: values for its variables, the exact text that will be sent, and
 * the terminals it goes to are all on screen before either send button is pressed. Values are never
 * saved. Sending goes to the chosen terminals once each, outside any broadcast group.
 */
export function SnippetRun({
  snippet,
  sessions,
  active,
  edit,
  duplicate,
  remove,
}: {
  snippet: Snippet;
  sessions: TerminalSession[];
  active?: string;
  edit: () => void;
  duplicate: () => void;
  remove: () => void;
}) {
  const candidates = sessions.filter((s) => !s.podTerminal && s.profile.protocol === 'ssh');
  const [values, setValues] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>(() =>
    candidates.some((s) => s.tabId === active) ? [active!] : [],
  );
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const names = variables(snippet.body);
  const parts = previewParts(snippet.body, values);
  const complete = names.every((name) => values[name]);
  const multiline = complete && needsPasteConfirmation(expand(snippet.body, values));
  const targets = candidates.filter((s) => selected.includes(s.tabId));

  function body() {
    const text = checkedBody(expand(snippet.body, values));
    if (needsPasteConfirmation(text) && !confirmed)
      throw new UserError('여러 줄이나 제어문자가 있습니다. 아래 확인란을 먼저 선택하세요.');
    return text;
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(checkedBody(expand(snippet.body, values)));
      setMessage({ text: '클립보드에 복사했습니다.', error: false });
    } catch (e) {
      setMessage({
        text: e instanceof UserError ? e.message : '클립보드에 복사하지 못했습니다.',
        error: true,
      });
    }
  }
  async function send(execute: boolean) {
    if (sending.current) return;
    let text: string;
    try {
      text = body();
      if (!targets.length || targets.length > 32)
        throw new UserError('보낼 터미널을 1~32개 고르세요.');
      if (!targets.every(ready))
        throw new UserError('연결이나 인증 상태가 바뀌었습니다. 보낼 터미널을 다시 확인하세요.');
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
      return;
    }
    const sent = targets.map((s) => ({
      id: s.connectionId,
      name: s.profile.name,
      bracketed: s.terminal.modes.bracketedPasteMode,
    }));
    sending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const results = await call<{ id: string; error: string | null }[]>('snippet_send', {
        targets: sent.map(({ id, bracketed }) => ({ id, bracketed })),
        body: text,
        execute,
      });
      const failed = results.filter((r) => r.error);
      setMessage({
        error: failed.length > 0,
        text: failed.length
          ? failed.map((r) => `${sent.find((t) => t.id === r.id)?.name}: ${r.error}`).join('\n')
          : `${results.length}개 터미널에 ${execute ? '실행했습니다' : '넣었습니다'}. 결과는 터미널에서 확인하세요.`,
      });
      setValues({});
      setConfirmed(false);
    } catch {
      setMessage({
        error: true,
        text: '전달 결과를 확인하지 못했습니다. 두 번 실행되지 않도록 터미널을 확인한 뒤 다시 시도하세요.',
      });
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="cmd-detail">
      <header className="cmd-detail-head">
        <div>
          <h3>{snippet.name}</h3>
          {snippet.description && <p>{snippet.description}</p>}
          {(snippet.group || snippet.tags) && (
            <div className="cmd-chips">
              {snippet.group && <span className="cmd-chip">{snippet.group}</span>}
              {snippet.tags
                .split(/\s+/)
                .filter(Boolean)
                .map((tag) => (
                  <span key={tag} className="cmd-chip tag">
                    #{tag}
                  </span>
                ))}
            </div>
          )}
        </div>
        <div className="cmd-detail-tools">
          <button aria-label="스니펫 수정" title="수정" onClick={edit}>
            <Icon name="edit" size={15} />
          </button>
          <button aria-label="스니펫 복제" title="복제" onClick={duplicate}>
            <Icon name="copy" size={15} />
          </button>
          <button aria-label="스니펫 삭제" title="삭제" onClick={remove}>
            <Icon name="trash" size={15} />
          </button>
        </div>
      </header>

      {names.length > 0 && (
        <section className="cmd-block" aria-label="값 입력">
          <h4>
            값 입력 <small>저장하지 않습니다</small>
          </h4>
          <div className="cmd-vars">
            {names.map((name) => (
              <label key={name}>
                <span>{name}</span>
                <input
                  autoComplete="off"
                  spellCheck={false}
                  value={values[name] ?? ''}
                  onChange={(e) => setValues({ ...values, [name]: e.target.value })}
                />
              </label>
            ))}
          </div>
        </section>
      )}

      <section className="cmd-block" aria-label="보낼 명령">
        <h4>보낼 명령</h4>
        <pre className="cmd-code" data-testid="snippet-preview">
          {parts.map((part, i) =>
            part.variable ? (
              <mark key={i} className={part.filled ? 'filled' : ''}>
                {part.text}
              </mark>
            ) : (
              part.text
            ),
          )}
        </pre>
        {names.length > 0 && (
          <p className="cmd-hint">값은 그대로 들어갑니다. 따옴표 같은 셸 인용은 직접 넣으세요.</p>
        )}
      </section>

      <section className="cmd-block" aria-label="보낼 터미널">
        <h4>보낼 터미널</h4>
        {candidates.length ? (
          <div className="cmd-targets">
            {candidates.map((s) => (
              <Target
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
          </div>
        ) : (
          <p className="cmd-hint">
            SSH·로컬·WSL 터미널을 먼저 여세요. 복사는 지금도 할 수 있습니다.
          </p>
        )}
      </section>

      {multiline && (
        <label className="checkbox cmd-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          여러 줄이나 제어문자가 있어 넣기만 해도 실행될 수 있음을 확인했습니다.
        </label>
      )}

      <footer className="cmd-actions">
        <p
          role="status"
          className={`cmd-message ${message?.error ? 'error' : ''}`}
          aria-live="polite"
        >
          {message?.text}
        </p>
        <button disabled={busy} onClick={() => void copy()}>
          복사
        </button>
        <button
          disabled={busy || !targets.length}
          title="커서 위치에 넣고 Enter는 누르지 않습니다"
          onClick={() => void send(false)}
        >
          입력만 넣기
        </button>
        <button
          className="primary"
          disabled={busy || !targets.length}
          title="넣은 뒤 Enter를 눌러 실행합니다"
          onClick={() => void send(true)}
        >
          실행
        </button>
      </footer>
    </div>
  );
}
