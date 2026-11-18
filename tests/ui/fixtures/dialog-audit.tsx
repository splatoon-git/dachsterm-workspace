import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { TerminalSession } from '../../../src/features/terminal/session';
import type { LocalFileOperation } from '../../../src/features/sftp/LocalFileDialog';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import { installDialogBridge, longName, longPath } from './dialog-audit-data';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';
import '../../../src/app/connectionTree.css';
import '../../../src/features/sessions/sessionForm.css';
import '../../../src/features/sftp/files.css';
import '../../../src/features/git/gitView.css';
import '../../../src/app/chatLauncher.css';

const params = new URLSearchParams(location.search);
installDialogBridge(params);
const { blankProfile } = await import('../../../src/lib/ipc');
const { SettingsDialog } = await import('../../../src/app/SettingsDialog');
const { GroupDialog } = await import('../../../src/app/GroupDialog');
const { default: SshKeyDialog } = await import('../../../src/components/SshKeyDialog');
const { VaultDialog } = await import('../../../src/features/sessions/VaultDialog');
const { SessionForm } = await import('../../../src/features/sessions/SessionForm');
const { ConfirmDialog, SaveAsDialog, UnsavedDialog } =
  await import('../../../src/features/editor/FileDialogs');
const { LocalFileDialog } = await import('../../../src/features/sftp/LocalFileDialog');
const { ChatOpenDialog } = await import('../../../src/features/chat/ChatOpenDialog');
const { AgentLaunchDialog, AgentNotTypedDialog } =
  await import('../../../src/features/agents/AgentLaunchDialog');
const { ForwardPortDialog } = await import('../../../src/features/tunnels/ForwardPortDialog');
const { TunnelPanel } = await import('../../../src/features/tunnels/TunnelPanel');
const { KubeActionDialog } = await import('../../../src/features/kube/KubeActionDialog');
const { OperateModeControl } = await import('../../../src/features/kube/OperateModeControl');
const { TerminalSettings } = await import('../../../src/features/terminal/TerminalSettings');
const { SessionLogDialog } = await import('../../../src/features/terminal/SessionLog');
const { GitWriteDialog } = await import('../../../src/features/git/GitWriteDialogs');
const { useGitWrite } = await import('../../../src/features/git/useGitWrite');
const { default: MarkdownPreview } = await import('../../../src/components/MarkdownPreview');

applyTheme(getCurrentTheme());
const noop = () => {};
const profile = {
  ...blankProfile(),
  id: 'layout',
  name: longName,
  host: 'layout.example.test',
  username: 'layout',
};
const snapshot = {
  profiles: Array.from({ length: 12 }, (_, i) => ({
    ...profile,
    id: `layout-${i}`,
    name: `${longName}${i}`,
  })),
  groups: [{ id: 'group', name: longName }],
};
const connected = { status: 'connected' };
const session = {
  kind: 'ssh',
  profile,
  connectionId: 'layout',
  snapshot: () => connected,
  subscribe: () => noop,
} as unknown as TerminalSession;

function GitDialog({
  kind,
}: {
  kind: 'branchCreate' | 'tag' | 'stash' | 'forcePush' | 'checkout' | 'discard';
}) {
  const repo = {
    kind: 'repo' as const,
    root: '/workspace',
    branch: longName,
    oid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [],
    truncated: false,
  };
  const write = useGitWrite({ session: undefined, repo, refresh: noop, notice: noop, ask: noop });
  const request =
    kind === 'discard' ? { kind, target: { paths: [longPath], untracked: [longPath] } } : { kind };
  return <GitWriteDialog request={request} repo={repo} close={noop} write={write} ask={noop} />;
}

function Harness() {
  const screen = params.get('screen') ?? 'settings';
  const [group, setGroup] = useState({ id: 'group', name: longName });
  const [operation, setOperation] = useState<LocalFileOperation>(() => ({
    kind: screen === 'file-edit' ? 'edit' : screen === 'file-delete' ? 'delete' : 'rename',
    program: 'code',
    value: longName,
  }));
  switch (screen) {
    case 'settings':
      return (
        <SettingsDialog
          open
          setOpen={noop}
          snapshot={snapshot}
          session={undefined}
          changed={noop}
        />
      );
    case 'group':
      return (
        <GroupDialog
          group={group}
          setGroup={(next) => next && setGroup(next)}
          snapshot={snapshot}
          action={async () => true}
        />
      );
    case 'key':
      return <SshKeyDialog close={noop} />;
    case 'vault':
      return <VaultDialog close={noop} />;
    case 'vault-reveal':
      return <VaultDialog revealProfile={profile} close={noop} />;
    case 'session':
      return (
        <SessionForm
          initial={profile}
          profiles={snapshot.profiles}
          groups={snapshot.groups}
          close={noop}
          saved={noop}
        />
      );
    case 'save-as':
      return <SaveAsDialog path={longPath} submit={noop} close={noop} />;
    case 'unsaved':
      return (
        <UnsavedDialog
          names={[longName]}
          canSave={false}
          busy={false}
          save={noop}
          discard={noop}
          cancel={noop}
        />
      );
    case 'unsaved-many':
      return (
        <UnsavedDialog
          names={[longName, longName + '.txt']}
          canSave
          busy={false}
          save={noop}
          discard={noop}
          cancel={noop}
        />
      );
    case 'confirm':
      return (
        <ConfirmDialog title="파일 삭제 확인" action="삭제" confirm={noop} cancel={noop}>
          <p>{longName} 파일을 삭제합니다.</p>
        </ConfirmDialog>
      );
    case 'file-edit':
    case 'file-delete':
    case 'file-rename':
      return (
        <LocalFileDialog
          operation={operation}
          selection={[longName]}
          error={params.get('state') === 'error' ? '선택한 경로를 열 수 없습니다. ' + longPath : ''}
          change={setOperation}
          fail={noop}
          close={noop}
          submit={noop}
        />
      );
    case 'chat-open':
      return <ChatOpenDialog profile={profile} program="claude" open={noop} close={noop} />;
    case 'agent-launch':
      return <AgentLaunchDialog profile={profile} folder={longPath} start={noop} close={noop} />;
    case 'agent-failed':
      return (
        <AgentNotTypedDialog
          sessionName={longName}
          line={'cd ' + longPath}
          copy={noop}
          close={noop}
        />
      );
    case 'ports':
      return (
        <ForwardPortDialog
          session={session}
          link={'http://localhost:8080/' + longName}
          close={noop}
        />
      );
    case 'tunnels':
      return (
        <TunnelPanel session={session} sessions={[session]} profiles={[profile]} close={noop} />
      );
    case 'kube-action':
      return (
        <KubeActionDialog
          connectionId="layout"
          context={longName}
          plan={{
            title: '파드 삭제',
            confirm: '삭제',
            target: longName,
            namespace: longName,
            impact: '소유 워크로드가 없어 삭제하면 복구되지 않습니다.',
            permanent: true,
            done: '',
            action: { kind: 'deletePod', namespace: longName, pod: longName },
          }}
          close={noop}
          done={noop}
        />
      );
    case 'kube-mode':
      return (
        <OperateModeControl
          context={longName}
          control={{ mode: 'off', reload: noop, change: async () => {} }}
        />
      );
    case 'terminal-settings':
      return <TerminalSettings close={noop} />;
    case 'session-log':
      return <SessionLogDialog session={session} connected close={noop} />;
    case 'git-branch':
      return <GitDialog kind="branchCreate" />;
    case 'git-tag':
      return <GitDialog kind="tag" />;
    case 'git-stash':
      return <GitDialog kind="stash" />;
    case 'git-force':
      return <GitDialog kind="forcePush" />;
    case 'git-checkout':
      return <GitDialog kind="checkout" />;
    case 'git-discard':
      return <GitDialog kind="discard" />;
    case 'external-link':
      return <MarkdownPreview text={`[외부 링크](https://example.test/${longName})`} />;
    default:
      throw new Error('Unknown dialog fixture');
  }
}
createRoot(document.getElementById('root')!).render(<Harness />);
