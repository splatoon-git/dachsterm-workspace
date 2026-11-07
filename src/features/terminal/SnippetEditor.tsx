import { useState } from 'react';
import { variables, type Snippet } from './snippets';

/**
 * Adds or changes one snippet. Saving asks the user to confirm the text holds no credentials,
 * since snippets are stored in plain text and can be exported.
 */
export function SnippetEditor({
  initial,
  isNew,
  groups,
  busy,
  save,
  cancel,
}: {
  initial: Snippet;
  isNew: boolean;
  /** Groups already in use, offered while typing. */
  groups: string[];
  busy: boolean;
  save: (snippet: Snippet) => void;
  cancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [noSecrets, setNoSecrets] = useState(false);
  const change = (key: keyof Snippet, value: string) => {
    setDraft({ ...draft, [key]: value });
    setNoSecrets(false);
  };
  const names = variables(draft.body);
  return (
    <form
      className="cmd-detail cmd-editor"
      aria-label={isNew ? '새 스니펫' : '스니펫 수정'}
      onSubmit={(e) => {
        e.preventDefault();
        save({ ...draft, name: draft.name.trim(), group: draft.group.trim() });
      }}
    >
      <header className="cmd-detail-head">
        <h3>{isNew ? '새 스니펫' : '스니펫 수정'}</h3>
      </header>
      <div className="cmd-editor-row">
        <label>
          이름
          <input
            required
            autoFocus
            maxLength={200}
            value={draft.name}
            onChange={(e) => change('name', e.target.value)}
          />
        </label>
        <label>
          그룹
          <input
            list="snippet-groups"
            maxLength={200}
            value={draft.group}
            onChange={(e) => change('group', e.target.value)}
          />
          <datalist id="snippet-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
      </div>
      <label>
        명령
        <textarea
          aria-label="명령 본문"
          required
          rows={4}
          maxLength={16384}
          spellCheck={false}
          value={draft.body}
          onChange={(e) => change('body', e.target.value)}
        />
        <small className="cmd-hint">
          실행할 때마다 바꿀 부분은 {'{{경로}}'}처럼 쓰면 보낼 때 값을 묻습니다.
          {names.length > 0 && ` 지금: ${names.join(', ')}`}
        </small>
      </label>
      <div className="cmd-editor-row">
        <label>
          태그
          <input
            placeholder="공백으로 구분"
            maxLength={200}
            value={draft.tags}
            onChange={(e) => change('tags', e.target.value)}
          />
        </label>
        <label>
          설명
          <input
            maxLength={1000}
            value={draft.description}
            onChange={(e) => change('description', e.target.value)}
          />
        </label>
      </div>
      <label className="checkbox cmd-confirm">
        <input
          type="checkbox"
          required
          checked={noSecrets}
          onChange={(e) => setNoSecrets(e.target.checked)}
        />
        비밀번호·개인키·Passphrase·OTP 같은 인증정보가 들어 있지 않습니다.
      </label>
      <footer className="cmd-actions">
        <span className="cmd-message" />
        <button type="button" disabled={busy} onClick={cancel}>
          취소
        </button>
        <button className="primary" disabled={busy || !noSecrets}>
          저장
        </button>
      </footer>
    </form>
  );
}
