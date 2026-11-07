import { useState } from 'react';
import { noteLocation, type ReviewNote } from './review';
import type { LineRange } from './unifiedDiff';

/** The comment form for the selected lines. Enter adds it; the comment is one prompt line. */
export function NoteComposer({
  path,
  range,
  add,
  cancel,
}: {
  path: string;
  range: LineRange;
  add: (text: string) => void;
  cancel: () => void;
}) {
  const [text, setText] = useState('');
  const submit = () => {
    if (text.trim()) add(text.trim());
  };
  return (
    <form
      className="review-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <strong>{noteLocation({ path, ...range })}</strong>
      <textarea
        aria-label="의견"
        placeholder="이 줄에 대한 의견 · Enter로 추가"
        autoFocus
        rows={2}
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            cancel();
          }
        }}
      />
      <div className="review-composer-actions">
        <button type="button" onClick={cancel}>
          취소
        </button>
        <button className="primary" disabled={!text.trim()}>
          목록에 추가
        </button>
      </div>
    </form>
  );
}

/** The review list, kept in memory until the tab closes, and where it goes. */
export function NoteList({
  notes,
  target,
  remove,
  clear,
  send,
  copy,
}: {
  notes: ReviewNote[];
  target: string;
  remove: (id: string) => void;
  clear: () => void;
  send: () => void;
  copy: () => void;
}) {
  return (
    <section className="review-notes" aria-label="검토 목록">
      <header>
        <strong>검토 목록 {notes.length}</strong>
        <button type="button" onClick={clear}>
          비우기
        </button>
        <button type="button" onClick={copy}>
          복사
        </button>
        <button
          className="primary"
          type="button"
          title={`${target} 터미널의 입력 줄에 넣습니다. Enter는 보내지 않습니다`}
          onClick={send}
        >
          프롬프트로 보내기 · {target}
        </button>
      </header>
      <ul>
        {notes.map((note) => (
          <li key={note.id}>
            <code>{noteLocation(note)}</code>
            <span>{note.text}</span>
            <button
              type="button"
              aria-label={`${noteLocation(note)} 의견 삭제`}
              onClick={() => remove(note.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
