import { useSyncExternalStore } from 'react';
import { EndedCard } from '../../components/EndedCard';
import { FilePanel } from './FilePanel';
import { TerminalSession } from '../terminal/session';
/** An FTP or FTPS tab: the file panel alone. Its target and state are in the status bar. */
export function FtpPane({
  session,
  reconnect,
  close,
}: {
  session: TerminalSession;
  reconnect: () => void;
  close?: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const ended = ['closed', 'error'].includes(state.status);
  return (
    <section
      className="ftp-pane"
      data-connection-id={session.connectionId}
      aria-label={`${session.profile.name} 파일`}
    >
      <div className="connection-message sr-only" role="status">
        {state.message}
      </div>
      {ended && <EndedCard message={state.message} reconnect={reconnect} close={close} />}
      <FilePanel session={session} />
    </section>
  );
}
