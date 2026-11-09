import { useSyncExternalStore, type ComponentProps } from 'react';
import { KubeWorkspace, type KubeCopyResult } from '../features/kube/KubeWorkspace';
import { kubeDisplay } from '../features/kube/kubeModel';
import { LocalCluster } from '../features/kube/localCluster';
import type { PodTerminalRequest } from '../features/kube/podShell';
import { FtpPane } from '../features/sftp/FtpPane';
import { usePaneView } from '../features/terminal/paneView';
import type { TerminalSession } from '../features/terminal/session';
import { capabilities } from '../features/terminal/sessionKind';
import { shellFacts, shellReadiness, typeInTerminal } from '../features/terminal/shellReadiness';
import { SessionTerminal } from './SessionTerminal';
import './sessionPane.css';

type TerminalProps = ComponentProps<typeof SessionTerminal>;
type KubeProps = TerminalProps & { openPodTerminal: (request: PodTerminalRequest) => void };

/** Chooses what a session's tab shows: FTP files, its terminal, or the Kubernetes workspace. */
export function SessionPane({
  open,
  ...props
}: KubeProps & { open: ComponentProps<typeof FtpPane>['open'] }) {
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

function KubeOrTerminal({ openPodTerminal, ...props }: KubeProps) {
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
        <LocalCluster.Provider value={!!session.localTarget}>
          <KubeWorkspace
            key={session.connectionId}
            connectionId={session.connectionId}
            persist={session.profile.workspace === 'kubernetes'}
            session={session.profile.id}
            sessionName={session.profile.name}
            visible={active}
            focused={focused ?? false}
            display={display}
            showTerminal={() => session.view.set({ kubeTerminal: true })}
            showWorkspace={() => session.view.set({ kubeTerminal: false })}
            copy={(command) => copyInto(session, command)}
            focusPod={view.kubeFocus}
            openTerminal={openPodTerminal}
          />
        </LocalCluster.Provider>
      )}
      <SessionTerminal
        {...props}
        active={active && terminalShown}
        focused={focused && terminalShown}
      />
    </div>
  );
}
