import { useSyncExternalStore, type ReactNode } from 'react';
import { MonitorBar } from '../features/monitoring/MonitorBar';
import { ProgramGuide } from '../features/terminal/CommandGuide';
import { isRecording, useLogStatus } from '../features/terminal/logStatus';
import type { TerminalSession } from '../features/terminal/session';
import { capabilities, sessionKind } from '../features/terminal/sessionKind';
import './statusBar.css';

function where(session: TerminalSession) {
  const { profile } = session;
  switch (sessionKind(session)) {
    case 'local':
      return null;
    case 'podtree':
      return profile.host;
    case 'ftp':
      return `${profile.protocol === 'ftp' ? 'FTP · TLS 없음' : 'FTPS · TLS 인증서 검증'} · ${profile.username}@${profile.host}:${profile.port}`;
    default:
      return `${profile.username}@${profile.host}:${profile.port}`;
  }
}

function Target({ session }: { session: TerminalSession }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const { profile } = session;
  const place = where(session);
  return (
    <span className="status-target" title={state.message}>
      <span
        className={`status-dot ${state.status === 'connected' ? 'online' : state.status}`}
        aria-hidden="true"
      />
      <strong>{profile.name}</strong>
      {place && <span>{place}</span>}
      <span className="status-message">{state.message}</span>
      {capabilities(session).terminal && (
        <span className="status-tag">{profile.encoding?.toUpperCase() ?? 'UTF-8'}</span>
      )}
      {profile.tmuxSession && (
        <span className="status-tag" title="탭을 닫아도 서버의 tmux 세션은 유지됩니다">
          tmux {profile.tmuxSession}
        </span>
      )}
    </span>
  );
}

function Recording({ session }: { session: TerminalSession }) {
  const status = useLogStatus(session.connectionId);
  if (status.state === 'error')
    return (
      <span className="status-alert" role="alert">
        기록 중단 · {status.message}
      </span>
    );
  if (!isRecording(status)) return null;
  return (
    <span className="status-rec" title={status.path}>
      REC{status.state === 'paused' ? ' · 일시정지' : ''}
    </span>
  );
}

/**
 * The one line under the workspace. It shows the focused pane only and is always there, so a
 * change in what it shows never resizes a terminal.
 */
export function StatusBar({
  session,
  game,
  input,
}: {
  session?: TerminalSession;
  /** The title of the focused game, when a game has the focus. */
  game?: string;
  /** Input scope controls, shown only while several panes are on screen. */
  input?: ReactNode;
}) {
  const can = session && capabilities(session);
  return (
    <footer className="status-bar" aria-label="작업 상태">
      <div className="status-left">
        {game ? (
          <span>로컬 · {game}</span>
        ) : session ? (
          <Target key={session.connectionId} session={session} />
        ) : (
          <span>
            <span className="status-dot" aria-hidden="true" />
            연결 없음
          </span>
        )}
      </div>
      <div className="status-center">
        {session && can?.guide && <ProgramGuide key={session.tabId} session={session} />}
      </div>
      <div className="status-right">
        {session && can?.log && <Recording key={session.connectionId} session={session} />}
        {input}
        {session && can?.monitor && <MonitorBar key={session.connectionId} session={session} />}
      </div>
    </footer>
  );
}
