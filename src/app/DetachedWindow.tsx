import { BroadcastControl } from '../features/terminal/BroadcastControl';
import { useFullscreen } from './useFullscreen';
import { useEffect, useState } from 'react';
import { useTheme } from '../themes/useTheme';
import { call, errorText, type Profile } from '../lib/ipc';
import { TerminalSession } from '../features/terminal/session';
import { TerminalPane } from '../features/terminal/TerminalPane';
import { FilePanel } from '../features/sftp/FilePanel';
import { MonitorBar } from '../features/monitoring/MonitorBar';
import { Icon } from '../components/Icon';
import { SnippetDialog } from '../features/terminal/SnippetDialog';
import { CommandCatalog } from '../features/terminal/CommandGuide';
export function DetachedWindow({ id }: { id: string }) {
  const theme = useTheme();
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [error, setError] = useState('');
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const { fullscreen, toggleFullscreen } = useFullscreen(setError);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code === 'F11' && !document.querySelector('dialog[open]')) {
        e.preventDefault();
        e.stopPropagation();
        void toggleFullscreen();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [toggleFullscreen]);
  const [filesOpen, setFilesOpen] = useState(true);
  useEffect(() => {
    let disposed = false;
    let current: TerminalSession | undefined;
    void call<{ profile: Profile; cols: number; rows: number }>('detached_info', { id })
      .then(async (info) => {
        if (disposed) return;
        current = new TerminalSession(info.profile, theme, () => {});
        await current.attach(id, info.cols, info.rows);
        if (!disposed) setSession(current);
      })
      .catch((e) => setError(errorText(e)));
    return () => {
      disposed = true;
      current?.release();
    };
    // Theme changes are applied by TerminalPane without rebuilding the connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return (
    <div className={`app-shell ${fullscreen ? 'terminal-fullscreen' : ''}`}>
      <header className="toolbar">
        <div className="brand">
          <Icon name="terminal" />
          <strong>{session?.profile.name ?? '터미널 인계 중'}</strong>
        </div>
        <div className="tools">
          <button aria-pressed={filesOpen} onClick={() => setFilesOpen((v) => !v)}>
            <Icon name="folder" size={16} />
            원격 파일
          </button>
          <small>독립 창 · 닫으면 이 연결 종료</small>
        </div>
      </header>
      <div className="workspace-controls detached-controls">
        <BroadcastControl />
        <button disabled={!session} onClick={() => setSnippetsOpen(true)}>
          스니펫
        </button>
        <button onClick={() => setCommandsOpen(true)}>기본 명령·로그 필터</button>
        <button onClick={() => void toggleFullscreen()}>
          {fullscreen ? '전체화면 종료' : '전체화면'}
        </button>
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <div className={`detached-grid ${filesOpen ? '' : 'files-hidden'}`}>
        {session && (
          <TerminalPane
            session={session}
            active
            theme={theme}
            reconnect={() => setError('연결을 종료한 뒤 기본 창의 세션 목록에서 새로 연결하세요.')}
          />
        )}
        {filesOpen && <FilePanel session={session ?? undefined} />}
      </div>
      {session && <MonitorBar session={session} />}
      {session && snippetsOpen && (
        <SnippetDialog
          sessions={[session]}
          active={session.tabId}
          close={() => setSnippetsOpen(false)}
        />
      )}
      {commandsOpen && <CommandCatalog close={() => setCommandsOpen(false)} />}
    </div>
  );
}
