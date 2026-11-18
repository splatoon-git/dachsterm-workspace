import { useSyncExternalStore, type ReactNode } from 'react';
import { MonitorBar } from '../features/monitoring/MonitorBar';
import { ProgramGuide } from '../features/terminal/CommandGuide';
import { isRecording, useLogStatus } from '../features/terminal/logStatus';
import type { TerminalSession } from '../features/terminal/session';
import { capabilities } from '../features/terminal/sessionKind';
import { serialLabel } from '../features/sessions/protocol';
import { userAtHost } from '../lib/ipc';
import { AgentBoard } from './AgentBoard';
import { GitStatusItem } from './GitStatusItem';
import type { AgentBoardState } from './useAgentBoard';
import './statusBar.css';

function where(session: TerminalSession) {
  const { profile } = session;
  switch (session.kind) {
    case 'local':
      return session.localTarget?.kind === 'wsl' ? 'WSL' : '로컬 셸';
    case 'pod':
      return profile.host;
    case 'serial':
      return `시리얼 · ${profile.host} · ${serialLabel(profile)}`;
    case 'telnet':
      return `Telnet · 암호화 없음 · ${profile.host}:${profile.port}`;
    case 'ftp':
      return `${profile.protocol === 'ftp' ? 'FTP · TLS 없음' : 'FTPS · TLS 인증서 검증'} · ${profile.username}@${profile.host}:${profile.port}`;
    default:
      return `${userAtHost(profile)}:${profile.port}`;
  }
}

function Target({ session }: { session: TerminalSession }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const { profile } = session;
  const place = where(session);
  // A local shell's ready message only repeats its name ("로컬 · Ubuntu"); other states still show.
  const message = session.kind === 'local' && state.status === 'connected' ? '' : state.message;
  return (
    <span className="status-target" title={state.message}>
      <span
        className={`status-dot ${state.status === 'connected' ? 'online' : state.status}`}
        aria-hidden="true"
      />
      <strong>{profile.name}</strong>
      {place && <span>{place}</span>}
      {message && <span className="status-message">{message}</span>}
      {capabilities(session).terminal && (
        <span className="status-tag">{profile.encoding?.toUpperCase() ?? 'UTF-8'}</span>
      )}
      {state.highlightPaused && (
        <span className="status-tag" title="출력이 빨라 하이라이트 규칙 검사를 잠시 멈췄습니다">
          하이라이트 일시 중지
        </span>
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
  file,
  game,
  input,
  sending,
  agents,
  showGit,
}: {
  session?: TerminalSession;
  /** The focused file tab's encoding, line ending, indentation and language. */
  file?: ReactNode;
  /** The title of the focused game, when a game has the focus. */
  game?: string;
  /** Input scope controls, shown only while several panes are on screen. */
  input?: ReactNode;
  /** Typing reaches several panes, which the whole bar warns about. */
  sending?: boolean;
  /** Every tab's program state. Only the main window gathers them. */
  agents?: AgentBoardState;
  /** Opens the sidebar's Git view. A detached window has none. */
  showGit?: () => void;
}) {
  const can = session && capabilities(session);
  return (
    <footer className={`status-bar ${sending ? 'input-sending' : ''}`} aria-label="작업 상태">
      <div className="status-left">
        {game ? (
          <span>로컬 · {game}</span>
        ) : session ? (
          <>
            <Target key={session.connectionId} session={session} />
            <GitStatusItem session={session} showGit={showGit} />
          </>
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
        {file}
        {agents && <AgentBoard board={agents} />}
        {session && can?.log && <Recording key={`log-${session.connectionId}`} session={session} />}
        {input}
        {session && can?.monitor && <MonitorBar key={session.connectionId} session={session} />}
      </div>
    </footer>
  );
}
