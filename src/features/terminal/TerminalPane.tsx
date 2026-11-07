import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import '@xterm/xterm/css/xterm.css';
import type { ThemeDefinition } from '../../themes/contract';
import type { TerminalSession } from './session';
import { errorText } from '../../lib/ipc';
import { EndedCard } from '../../components/EndedCard';
import { SessionLogDialog } from './SessionLog';
import { TerminalSearch } from './TerminalSearch';
import { usePaneView } from './paneView';
import { capabilities } from './sessionKind';
import { AuthenticationPrompt } from './AuthenticationPrompt';
import { attachFontSizeWheel } from './fontWheel';
import { afterRendererResumes, throttleTrailing } from './fitThrottle';
import { PasteConfirm } from './PasteConfirm';
import { PromptAttachConfirm } from './PromptAttachConfirm';
import { usePromptAttachments } from './usePromptAttachments';
import { useInputReach } from './broadcastStatus';
import { needsPasteConfirmation, useTerminalDisplay, useTerminalPreferences } from './preferences';
import { AgentSignCard } from './AgentSignCard';
import { currentSign } from './agentSign';
const FIT_INTERVAL_MS = 60;
const hasImage = (data: DataTransfer | null) =>
  Array.from(data?.items ?? []).some((item) => item.type.startsWith('image/'));
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
  close,
}: {
  session: TerminalSession;
  active: boolean;
  focused?: boolean;
  theme: ThemeDefinition;
  reconnect: () => void;
  /** Closes the tab, offered when the connection has ended. */
  close?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const view = usePaneView(session.view);
  const signs = useSyncExternalStore(session.agentSign.subscribe, session.agentSign.snapshot);
  const { fontSize, scrollback } = useTerminalDisplay();
  const [paste, setPaste] = useState<{ id: string; text: string } | null>(null);
  const preferences = useTerminalPreferences();
  const reach = useInputReach(session.connectionId);
  const pane = useRef<HTMLElement>(null);
  const attachments = usePromptAttachments(session, active, pane);
  const { attachImage } = attachments;
  const pasteClipboard = useCallback(async () => {
    const id = session.connectionId;
    if (session.snapshot().status !== 'connected') return;
    try {
      const text = await navigator.clipboard.readText();
      if (id !== session.connectionId || session.snapshot().status !== 'connected') return;
      if (!text) await attachImage();
      else if (needsPasteConfirmation(text)) setPaste({ id, text });
      else {
        session.terminal.paste(text);
        session.terminal.focus();
      }
    } catch (e) {
      session.notice(errorText(e));
    }
  }, [attachImage, session]);
  useEffect(() => {
    const element = host.current!;
    if (!session.terminal.element) session.terminal.open(element);
    else element.appendChild(session.terminal.element);
    let cancelFit = () => {};
    const fit = throttleTrailing(() => {
      cancelFit();
      cancelFit = afterRendererResumes(() => {
        if (element.clientWidth && element.clientHeight) fitTerminal(session);
      });
    }, FIT_INTERVAL_MS);
    const observer = new ResizeObserver(() => fit.call());
    observer.observe(element);
    const intercept = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain');
      const image = !text && hasImage(event.clipboardData);
      if (image || (text && needsPasteConfirmation(text))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (image) void attachImage();
        else if (text) setPaste({ id: session.connectionId, text });
      }
    };
    element.addEventListener('paste', intercept, true);
    const seen = () => session.programStatus.acknowledge();
    element.addEventListener('focusin', seen);
    const detachWheel = attachFontSizeWheel(element, () =>
      session.notice('터미널 설정을 저장하지 못했습니다.'),
    );
    return () => {
      observer.disconnect();
      fit.cancel();
      cancelFit();
      element.removeEventListener('paste', intercept, true);
      element.removeEventListener('focusin', seen);
      detachWheel();
    };
  }, [attachImage, session]);
  useEffect(() => {
    const element = host.current!;
    const copy = () => {
      const selected = session.terminal.getSelection();
      if (selected) session.copyText(selected);
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
      void pasteClipboard();
    };
    session.terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || event.isComposing) return true;
      const enter = session.enterSequence(event);
      if (enter) {
        event.preventDefault();
        session.send(enter);
        return false;
      }
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
        void pasteClipboard();
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
  }, [session, preferences, pasteClipboard]);
  useEffect(() => {
    session.useOptionAsMeta(preferences.macOptionAsMeta);
  }, [session, preferences.macOptionAsMeta]);
  useEffect(() => {
    session.applyTheme(theme);
  }, [session, theme]);
  useEffect(() => {
    session.configure(fontSize, scrollback);
    if (active) return afterRendererResumes(() => fitTerminal(session));
  }, [session, active, fontSize, scrollback]);
  useEffect(() => {
    // Visibility is shared by all split panes; keyboard ownership is not.
    // Keep focus in a pane's search/select controls when the user chooses them.
    // Separate from the effect above: changing the font size must not move focus.
    if (
      active &&
      focused &&
      !host.current?.closest('.terminal-pane')?.contains(document.activeElement)
    )
      session.terminal.focus();
  }, [session, active, focused]);
  const ended = ['closed', 'error'].includes(state.status);
  const sign = state.status === 'connected' ? currentSign(signs, session.connectionId) : null;
  return (
    <section
      ref={pane}
      className="terminal-pane"
      data-connection-id={session.connectionId}
      hidden={!active}
      aria-label={`${session.profile.name} 터미널`}
    >
      {/* The status bar shows the focused pane; this keeps every pane's state for screen readers. */}
      <div className="connection-message sr-only" role="status">
        {state.message}{' '}
        <span className="encoding-badge">{session.profile.encoding?.toUpperCase() ?? 'UTF-8'}</span>
        {session.profile.tmuxSession && (
          <span className="encoding-badge">tmux {session.profile.tmuxSession}</span>
        )}
      </div>
      {view.search && <TerminalSearch session={session} />}
      {view.log && capabilities(session).log && (
        <SessionLogDialog
          session={session}
          connected={state.status === 'connected'}
          close={() => session.view.set({ log: false })}
        />
      )}
      {ended && !state.hostKey && (
        <EndedCard message={state.message} reconnect={reconnect} close={close} />
      )}
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
      {sign && (
        <AgentSignCard
          key={sign.request}
          request={sign}
          answer={(decision) => void session.agentSign.answer(sign, decision)}
        />
      )}
      {state.authPrompt && (
        <AuthenticationPrompt
          key={state.authPrompt.challenge}
          session={session}
          prompt={state.authPrompt}
        />
      )}
      {paste !== null && paste.id === session.connectionId && state.status === 'connected' && (
        <PasteConfirm
          text={paste.text}
          reach={reach}
          cancel={() => setPaste(null)}
          confirm={() => {
            session.terminal.paste(paste.text);
            session.terminal.focus();
            setPaste(null);
          }}
        />
      )}
      {attachments.pending && state.status === 'connected' && (
        <PromptAttachConfirm
          attachment={attachments.pending}
          server={`${session.profile.name} (${session.profile.host})`}
          cancel={attachments.cancel}
          confirm={attachments.confirm}
        />
      )}
      <div className="live-terminal" ref={host} />
    </section>
  );
}
