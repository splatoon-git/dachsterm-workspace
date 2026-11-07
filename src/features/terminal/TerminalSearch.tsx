import { useState } from 'react';
import type { TerminalSession } from './session';

/** Search box over the terminal, opened from the tab menu or Ctrl/Cmd+Shift+F. */
export function TerminalSearch({ session }: { session: TerminalSession }) {
  const [query, setQuery] = useState('');
  const close = () => {
    session.search.clearDecorations();
    session.view.set({ search: false });
    session.terminal.focus();
  };
  return (
    <div className="terminal-search" role="search" aria-label="터미널 출력 검색">
      <input
        aria-label="터미널 검색"
        placeholder="터미널 검색"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (e.shiftKey) session.search.findPrevious(query);
            else session.search.findNext(query);
          }
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
      />
      <button
        disabled={!query}
        title="이전 검색 결과 · Shift+Enter"
        onClick={() => session.search.findPrevious(query)}
        aria-label="이전 검색 결과"
      >
        ↑
      </button>
      <button
        disabled={!query}
        title="다음 검색 결과 · Enter"
        onClick={() => session.search.findNext(query)}
        aria-label="다음 검색 결과"
      >
        ↓
      </button>
      <button title="닫기 · Esc" aria-label="검색 닫기" onClick={close}>
        ×
      </button>
    </div>
  );
}
