import { useSyncExternalStore } from 'react';
import { FilePanel } from './FilePanel';
import { TerminalSession } from '../terminal/session';
export function FtpPane({
  session,
  reconnect,
}: {
  session: TerminalSession;
  reconnect: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  return (
    <section className="ftp-pane" data-connection-id={session.connectionId}>
      <div className="ftp-heading">
        <div>
          <strong>{session.profile.name}</strong>
          <small>
            {session.profile.protocol.toUpperCase()} · {session.profile.username}@
            {session.profile.host}:{session.profile.port}
          </small>
        </div>
        <div>
          <span role="status">{state.message}</span>
          {['closed', 'error'].includes(state.status) ? (
            <button onClick={reconnect}>재접속</button>
          ) : (
            <button onClick={() => void session.disconnect()}>연결 종료</button>
          )}
        </div>
      </div>
      <FilePanel session={session} />
    </section>
  );
}
