import { Icon } from '../../components/Icon';
import type { TerminalSession } from '../terminal/session';
import { FilePanel } from './FilePanel';
import { LocalFilePanel } from './LocalFilePanel';

/** Chooses the sidebar's file view for the selected tab. FTP tabs show files in the tab itself. */
export function SidebarFiles({
  session,
  showConnections,
}: {
  session?: TerminalSession;
  showConnections: () => void;
}) {
  if (session?.localTarget)
    return (
      <LocalFilePanel key={session.connectionId} session={session} target={session.localTarget} />
    );
  if (session && session.profile.protocol !== 'ssh')
    return (
      <div className="file-empty">
        <Icon name="folder" size={32} />
        <h3>파일 작업 탭 사용 중</h3>
        <p>이 연결의 파일은 중앙 작업 탭에서 탐색할 수 있습니다.</p>
        <button onClick={showConnections}>연결 목록 보기</button>
      </div>
    );
  return <FilePanel session={session?.podTerminal ? undefined : session} />;
}
