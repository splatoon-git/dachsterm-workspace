import { useSyncExternalStore, type ComponentProps } from 'react';
import { KubeWorkspace, type KubeCopyResult } from '../features/kube/KubeWorkspace';
import { kubeDisplay } from '../features/kube/kubeModel';
import { FtpPane } from '../features/sftp/FtpPane';
import { usePaneView } from '../features/terminal/paneView';
import type { TerminalSession } from '../features/terminal/session';
import { capabilities } from '../features/terminal/sessionKind';
import { shellFacts, shellReadiness, typeInTerminal } from '../features/terminal/shellReadiness';
import { SessionTerminal } from './SessionTerminal';
import './sessionPane.css';

type TerminalProps = ComponentProps<typeof SessionTerminal>;

/** Chooses what a session's tab shows: FTP files, its terminal, or the Kubernetes workspace. */
export function SessionPane({
  open,
  ...props
}: TerminalProps & { open: ComponentProps<typeof FtpPane>['open'] }) {
  if (capabilities(props.session).terminal) return <KubeOrTerminal {...props} />;
  return (
    <FtpPane session={props.session} open={open} reconnect={props.reconnect} close={props.close} />
  );
}

/** Types the copy command when the shell can take it, or says why not. */
function copyInto(session: TerminalSession, command: string): KubeCopyResult {
  const readiness = shellReadiness(shellFacts(session));
  if (readiness.state === 'blocked') return { blocked: readiness.text };
  session.view.set({ kubeTerminal: true });
  if (readiness.state === 'ready') {
    typeInTerminal(session, command);
    return { typed: 'run' };
  }
  // Nothing says what this hidden shell is doing, so the user presses Enter after looking at it.
  session.send(command);
  session.terminal.focus();
  return { typed: 'wait' };
}

function KubeOrTerminal(props: TerminalProps) {
  const { session, active, focused } = props;
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const view = usePaneView(session.view);
  const display = kubeDisplay({
    workspace: session.profile.workspace,
    opened: view.kube,
    onTerminal: view.kubeTerminal,
    connected: state.status === 'connected',
  });
  const terminalShown = display !== 'workspace';
  return (
    <div className="session-pane">
      {display !== 'off' && (
        <KubeWorkspace
          key={session.connectionId}
          connectionId={session.connectionId}
          persist={session.profile.workspace === 'kubernetes'}
          session={session.profile.id}
          visible={active}
          focused={focused ?? false}
          display={display}
          showTerminal={() => session.view.set({ kubeTerminal: true })}
          showWorkspace={() => session.view.set({ kubeTerminal: false })}
          copy={(command) => copyInto(session, command)}
        />
      )}
      <SessionTerminal
        {...props}
        active={active && terminalShown}
        focused={focused && terminalShown}
      />
    </div>
  );
}
