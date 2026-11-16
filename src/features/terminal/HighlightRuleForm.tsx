import { useEffect, useState, type FormEvent } from 'react';
import { call, desktop, errorText, type Snapshot } from '../../lib/ipc';
import { useTheme } from '../../themes/useTheme';
import {
  highlightColors,
  highlightHex,
  matchesSecretPrompt,
  maxPattern,
  patternError,
  ruleError,
  type HighlightColor,
  type HighlightRule,
} from './highlightRules';
import { trySample } from './highlightSample';

type Choice = { id: string; name: string };

/** The saved sessions a rule can be limited to. Read once, when that scope is chosen. */
function useSessionChoices(wanted: boolean) {
  const [choices, setChoices] = useState<Choice[] | null>(null);
  useEffect(() => {
    if (!wanted || choices || !desktop) return;
    void call<Snapshot>('sessions')
      .then((s) => setChoices(s.profiles.map(({ id, name }) => ({ id, name }))))
      .catch(() => setChoices([]));
  }, [wanted, choices]);
  return choices ?? [];
}

const splitTags = (text: string) =>
  text
    .split(/[,\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);

/** One rule's editor. Saving tries the pattern on sample output first, in the matching worker. */
export function HighlightRuleForm({
  rule,
  save,
  cancel,
}: {
  rule: HighlightRule;
  save: (rule: HighlightRule) => Promise<void>;
  cancel: () => void;
}) {
  const theme = useTheme();
  const [draft, setDraft] = useState(rule);
  const [tags, setTags] = useState(rule.scope.kind === 'tags' ? rule.scope.tags.join(', ') : '');
  const [sendText, setSendText] = useState(rule.send?.text ?? '');
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const sessions = useSessionChoices(draft.scope.kind === 'sessions');
  const change = (patch: Partial<HighlightRule>) => setDraft((d) => ({ ...d, ...patch }));
  const secret = matchesSecretPrompt(draft.pattern, draft.ignoreCase);
  const syntax = draft.pattern ? patternError(draft.pattern, draft.ignoreCase) : null;
  const finalRule = (): HighlightRule => ({
    ...draft,
    name: draft.name.trim(),
    scope: draft.scope.kind === 'tags' ? { kind: 'tags', tags: splitTags(tags) } : draft.scope,
    send: draft.send && { ...draft.send, text: sendText },
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = finalRule();
    const problem = ruleError(next);
    if (problem) return setMessage(problem);
    setBusy(true);
    try {
      const tried = await trySample(next);
      if (tried === 'slow')
        return setMessage(
          '이 패턴은 검사에 너무 오래 걸립니다. 반복(+, *)이 겹치지 않게 고치세요.',
        );
      await save(next);
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const toggleSession = (id: string, on: boolean) => {
    const ids = draft.scope.kind === 'sessions' ? draft.scope.ids : [];
    change({ scope: { kind: 'sessions', ids: on ? [...ids, id] : ids.filter((i) => i !== id) } });
  };
  return (
    <form className="highlight-form" onSubmit={(e) => void submit(e)} aria-label="하이라이트 규칙">
      <label>
        이름
        <input
          autoFocus
          maxLength={100}
          value={draft.name}
          onChange={(e) => change({ name: e.target.value })}
        />
      </label>
      <label>
        패턴 (정규식)
        <input
          className="mono"
          spellCheck={false}
          maxLength={maxPattern}
          value={draft.pattern}
          onChange={(e) => change({ pattern: e.target.value })}
        />
        {syntax && <small role="alert">{syntax}</small>}
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={draft.ignoreCase}
          onChange={(e) => change({ ignoreCase: e.target.checked })}
        />
        대소문자 구분 안 함
      </label>
      <div className="highlight-form-row">
        <label>
          색
          <select
            value={draft.color ?? ''}
            onChange={(e) => change({ color: (e.target.value || null) as HighlightColor | null })}
          >
            <option value="">칠하지 않음</option>
            {highlightColors.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        {draft.color && (
          <span
            className="highlight-swatch"
            aria-hidden="true"
            style={{
              color: highlightHex(theme, draft.color),
              background: theme.terminal.background,
            }}
          >
            ERROR 예시
          </span>
        )}
      </div>
      <label>
        적용할 탭
        <select
          value={draft.scope.kind}
          onChange={(e) => {
            const kind = e.target.value as HighlightRule['scope']['kind'];
            change({
              scope:
                kind === 'all'
                  ? { kind }
                  : kind === 'tags'
                    ? { kind, tags: splitTags(tags) }
                    : { kind, ids: [] },
            });
          }}
        >
          <option value="all">모든 터미널</option>
          <option value="tags">태그가 있는 세션</option>
          <option value="sessions">고른 세션</option>
        </select>
      </label>
      {draft.scope.kind === 'tags' && (
        <label>
          태그
          <input
            placeholder="쉼표나 공백으로 구분"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </label>
      )}
      {draft.scope.kind === 'sessions' && (
        <fieldset className="highlight-sessions">
          <legend>세션</legend>
          {sessions.length === 0 && <small>저장된 세션이 없습니다.</small>}
          {sessions.map((s) => (
            <label key={s.id} className="checkbox">
              <input
                type="checkbox"
                checked={draft.scope.kind === 'sessions' && draft.scope.ids.includes(s.id)}
                onChange={(e) => toggleSession(s.id, e.target.checked)}
              />
              {s.name}
            </label>
          ))}
        </fieldset>
      )}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={draft.notify}
          onChange={(e) => change({ notify: e.target.checked })}
        />
        일치하면 알림 (다른 작업 중이면 OS 알림)
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!draft.send || confirming}
          disabled={secret && !draft.send}
          onChange={(e) => {
            if (!e.target.checked) {
              setConfirming(false);
              change({ send: null });
            } else setConfirming(true);
          }}
        />
        일치하면 입력 보내기
      </label>
      {secret && (
        <small className="highlight-note">
          암호·Passphrase·인증 코드를 묻는 줄과 일치하는 패턴에는 입력 보내기를 켤 수 없습니다.
        </small>
      )}
      {confirming && !draft.send && (
        <div className="highlight-warning" role="alert">
          <p>
            서버 출력이 이 패턴과 일치하면 아래 입력이 이 탭에 그대로 입력됩니다. 출력은 서버가
            정하므로 의도하지 않은 명령이 실행될 수 있습니다. 같은 탭에서는 10초에 한 번만 보내고,
            동시 입력 중에는 보내지 않습니다.
          </p>
          <div className="highlight-actions">
            <button type="button" onClick={() => setConfirming(false)}>
              취소
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                setConfirming(false);
                change({ send: { text: sendText, confirmedAt: Date.now() } });
              }}
            >
              이해했고 켭니다
            </button>
          </div>
        </div>
      )}
      {draft.send && (
        <label>
          보낼 입력 (줄바꿈은 Enter)
          <textarea
            className="mono"
            rows={2}
            spellCheck={false}
            value={sendText}
            onChange={(e) => setSendText(e.target.value)}
          />
        </label>
      )}
      <footer className="highlight-actions">
        <span className="highlight-message" role="status">
          {message}
        </span>
        <button type="button" disabled={busy} onClick={cancel}>
          취소
        </button>
        <button className="primary" disabled={busy || (confirming && !draft.send)}>
          저장
        </button>
      </footer>
    </form>
  );
}
