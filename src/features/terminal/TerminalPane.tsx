import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import '@xterm/xterm/css/xterm.css';
import type { ThemeDefinition } from '../../themes/contract';
import type { TerminalSession } from './session';
import { errorText } from '../../lib/ipc';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { SessionLog } from './SessionLog';
import { ProgramGuide } from './CommandGuide';
import { AuthenticationPrompt } from './AuthenticationPrompt';
import {
  needsPasteConfirmation,
  saveTerminalPreferences,
  useTerminalPreferences,
} from './preferences';
function fitTerminal(session: TerminalSession) {
  const buffer = session.terminal.buffer.active;
  const atBottom = buffer.viewportY >= buffer.baseY;
  session.fit.fit();
  // A split/zoom resize should follow output if the user was already at the end.
  // Preserve deliberate scrollback positions in all other cases.
  if (atBottom) session.terminal.scrollToBottom();
}
export function TerminalPane({
  session,
  active,
  focused = active,
  theme,
  reconnect,
}: {
  session: TerminalSession;
  active: boolean;
  focused?: boolean;
  theme: ThemeDefinition;
  reconnect: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const [query, setQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fontSize, setFontSize] = useState(
    () => Number(localStorage.getItem('daxterm.fontSize')) || 14,
  );
  const [scrollback, setScrollback] = useState(
    () => Number(localStorage.getItem('daxterm.scrollback')) || 5000,
  );
  const [paste, setPaste] = useState<{ id: string; text: string } | null>(null);
  const preferences = useTerminalPreferences();
  useEffect(() => {
    const update = (e: StorageEvent) => {
      if (e.key === 'daxterm.fontSize') setFontSize(Number(e.newValue) || 14);
      if (e.key === 'daxterm.scrollback') setScrollback(Number(e.newValue) || 5000);
    };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);
  useEffect(() => {
    const element = host.current!;
    if (!session.terminal.element) session.terminal.open(element);
    else element.appendChild(session.terminal.element);
    const observer = new ResizeObserver(() => {
      if (element.clientWidth && element.clientHeight) fitTerminal(session);
    });
    observer.observe(element);
    const intercept = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain');
      if (text && needsPasteConfirmation(text)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPaste({ id: session.connectionId, text });
      }
    };
    element.addEventListener('paste', intercept, true);
    return () => {
      observer.disconnect();
      element.removeEventListener('paste', intercept, true);
    };
  }, [session]);
  useEffect(() => {
    const element = host.current!;
    const copy = () => {
      const selected = session.terminal.getSelection();
      if (selected)
        void navigator.clipboard.writeText(selected).catch((e) => session.notice(errorText(e)));
    };
    const paste = async () => {
      if (session.snapshot().status !== 'connected') return;
      const id = session.connectionId;
      try {
        const text = await navigator.clipboard.readText();
        if (id !== session.connectionId || session.snapshot().status !== 'connected') return;
        if (needsPasteConfirmation(text)) setPaste({ id, text });
        else {
          session.terminal.paste(text);
          session.terminal.focus();
        }
      } catch (e) {
        session.notice(errorText(e));
      }
    };
    const mouseup = (event: MouseEvent) => {
      if (event.button === 0 && preferences.copyOnSelect) copy();
    };
    const context = (event: MouseEvent) => {
      // A TUI owns mouse reporting unless Shift explicitly overrides it.
      if (
        !preferences.rightClickPaste ||
        (session.terminal.modes.mouseTrackingMode !== 'none' && !event.shiftKey)
      )
        return;
      event.preventDefault();
      void paste();
    };
    session.terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || event.isComposing) return true;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyC') {
        event.preventDefault();
        copy();
        return false;
      }
      if (
        ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyV') ||
        (event.shiftKey && event.code === 'Insert')
      ) {
        event.preventDefault();
        void paste();
        return false;
      }
      if (
        preferences.backspace === 'bs' &&
        event.key === 'Backspace' &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        session.send('\x08');
        return false;
      }
      return true;
    });
    element.addEventListener('mouseup', mouseup);
    element.addEventListener('contextmenu', context);
    return () => {
      session.terminal.attachCustomKeyEventHandler(() => true);
      element.removeEventListener('mouseup', mouseup);
      element.removeEventListener('contextmenu', context);
    };
  }, [session, preferences]);
  useEffect(() => {
    session.applyTheme(theme);
  }, [session, theme]);
  useEffect(() => {
    session.configure(fontSize, scrollback);
    if (active) {
      fitTerminal(session);
      // Visibility is shared by all split panes; keyboard ownership is not.
      // Keep focus in a pane's search/select controls when the user chooses them.
      if (focused && !host.current?.closest('.terminal-pane')?.contains(document.activeElement))
        session.terminal.focus();
    }
  }, [session, active, focused, fontSize, scrollback]);
  const ended = ['closed', 'error'].includes(state.status);
  async function pasteClipboard() {
    const id = session.connectionId;
    try {
      const text = await navigator.clipboard.readText();
      if (id !== session.connectionId || session.snapshot().status !== 'connected') return;
      if (needsPasteConfirmation(text)) setPaste({ id, text });
      else {
        session.terminal.paste(text);
        session.terminal.focus();
      }
    } catch (e) {
      session.notice(errorText(e));
    }
  }
  return (
    <section
      className="terminal-pane"
      data-connection-id={session.connectionId}
      hidden={!active}
      aria-label={`${session.profile.name} 터미널`}
    >
      <div className="terminal-tools">
        <div className="terminal-search" role="search" aria-label="터미널 출력 검색">
          <input
            aria-label="터미널 검색"
            placeholder="터미널 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.shiftKey) session.search.findPrevious(query);
                else session.search.findNext(query);
              }
              if (e.key === 'Escape') {
                setQuery('');
                session.search.clearDecorations();
                session.terminal.focus();
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
        </div>
        <div className="terminal-actions">
          {!session.podtree && (
            <SessionLog session={session} connected={state.status === 'connected'} />
          )}
          <button
            onClick={() => {
              void navigator.clipboard
                .writeText(session.terminal.getSelection())
                .catch((e) => session.notice(errorText(e)));
            }}
          >
            복사
          </button>
          <button onClick={() => void pasteClipboard()} disabled={state.status !== 'connected'}>
            붙여넣기
          </button>
          <button
            aria-label="터미널 설정"
            title="글꼴 크기 · 스크롤 기록"
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="settings" size={16} />
          </button>
          {ended ? (
            <button onClick={reconnect}>재접속</button>
          ) : (
            <button onClick={() => void session.disconnect()}>연결 종료</button>
          )}
        </div>
      </div>
      {settingsOpen && (
        <Dialog title="터미널 설정" close={() => setSettingsOpen(false)}>
          <div className="terminal-preferences">
            {(
              [
                ['copyOnSelect', '마우스 선택 시 자동 복사'],
                ['rightClickPaste', '마우스 우클릭 붙여넣기'],
                ['followDirectory', '새 SFTP 탐색기의 터미널 경로 따라가기'],
              ] as const
            ).map(([key, label]) => (
              <label className="checkbox" key={key}>
                <input
                  type="checkbox"
                  checked={preferences[key]}
                  onChange={(e) => {
                    try {
                      saveTerminalPreferences({ [key]: e.target.checked });
                    } catch {
                      session.notice('터미널 설정을 저장하지 못했습니다.');
                    }
                  }}
                />
                {label}
              </label>
            ))}
            <label>
              Backspace 전송
              <select
                aria-label="Backspace 전송"
                value={preferences.backspace}
                onChange={(e) => {
                  try {
                    saveTerminalPreferences({ backspace: e.target.value as 'del' | 'bs' });
                  } catch {
                    session.notice('터미널 설정을 저장하지 못했습니다.');
                  }
                }}
              >
                <option value="del">DEL · 표준 기본값</option>
                <option value="bs">Ctrl+H · 오래된 서버 호환</option>
              </select>
            </label>
            <label>
              글꼴 크기
              <select
                aria-label="글꼴 크기"
                value={fontSize}
                onChange={(e) => {
                  setFontSize(Number(e.target.value));
                  localStorage.setItem('daxterm.fontSize', e.target.value);
                }}
              >
                {[12, 14, 16, 18, 20, 24].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <label>
              스크롤 기록
              <select
                aria-label="스크롤백"
                value={scrollback}
                onChange={(e) => {
                  setScrollback(Number(e.target.value));
                  localStorage.setItem('daxterm.scrollback', e.target.value);
                }}
              >
                {[1000, 5000, 10000].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted">
            마우스·키 설정은 열린 터미널과 새 창에도 적용됩니다. Ctrl/Cmd+Shift+C/V, Shift+Insert를
            사용할 수 있습니다. 마우스를 사용하는 TUI에서는 Shift+드래그/우클릭으로
            선택·붙여넣기합니다. 방향키·Home/End·Delete·Tab·Ctrl+C는 터미널 표준 모드를 따릅니다.
          </p>
        </Dialog>
      )}
      <div
        className={`connection-message ${state.status === 'error' ? 'error' : ''}`}
        role="status"
      >
        {state.message}{' '}
        <span className="encoding-badge">{session.profile.encoding?.toUpperCase() ?? 'UTF-8'}</span>
      </div>
      {state.hostKey && (
        <div className="trust-card" role="alert" aria-label="최초 호스트키 확인">
          <h2>이 서버를 신뢰하시겠습니까?</h2>
          <p>
            서버 관리자가 제공한 지문과 비교하세요. 신뢰하면 이 기기의 known_hosts에 저장됩니다.
          </p>
          <p>
            {state.hostKey.host}:{state.hostKey.port} · {state.hostKey.algorithm}
          </p>
          <code>{state.hostKey.fingerprint}</code>
          <div className="form-actions">
            <button onClick={() => void session.trust(false)}>거부</button>
            <button className="primary" onClick={() => void session.trust(true)}>
              지문 확인 · 신뢰하고 연결
            </button>
          </div>
        </div>
      )}
      {state.authPrompt && (
        <AuthenticationPrompt
          key={state.authPrompt.challenge}
          session={session}
          prompt={state.authPrompt}
        />
      )}
      {paste !== null && paste.id === session.connectionId && state.status === 'connected' && (
        <div className="trust-card" role="alert">
          <p>여러 줄 또는 제어문자가 포함되어 있습니다. 붙여넣으면 명령이 실행될 수 있습니다.</p>
          <div className="form-actions">
            <button onClick={() => setPaste(null)}>취소</button>
            <button
              onClick={() => {
                session.terminal.paste(paste.text);
                session.terminal.focus();
                setPaste(null);
              }}
            >
              붙여넣기 실행
            </button>
          </div>
        </div>
      )}
      <div className="live-terminal" ref={host} />
      {!session.podtree && <ProgramGuide key={session.connectionId} session={session} />}
    </section>
  );
}
