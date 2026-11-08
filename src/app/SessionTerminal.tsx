import { useEffect, useSyncExternalStore, type ComponentProps } from 'react';
import { TerminalPane } from '../features/terminal/TerminalPane';
import { ForwardPortDialog } from '../features/tunnels/ForwardPortDialog';
import { PromptBranch } from './PromptBranch';

/** Connects terminal signals to other features, which must not import each other directly. */
export function SessionTerminal(props: ComponentProps<typeof TerminalPane>) {
  const { session, active } = props;
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const connected = state.status === 'connected';
  useEffect(() => {
    if (active && connected) void session.syncTmuxDirectory();
  }, [active, connected, session]);
  return (
    <>
      <TerminalPane {...props}>
        <PromptBranch session={session} active={active} />
      </TerminalPane>
      {connected && state.serverLink && (
        <ForwardPortDialog
          session={session}
          link={state.serverLink}
          close={() => session.closeServerLink()}
        />
      )}
    </>
  );
}
