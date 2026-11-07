import { InputScopeControl } from '../features/terminal/InputScope';
import { useInputScope } from '../features/terminal/useInputScope';
import { useFullscreen } from './useFullscreen';
import { useEffect, useState } from 'react';
import { useTheme } from '../themes/useTheme';
import { call, errorText, type Profile } from '../lib/ipc';
import { TerminalSession } from '../features/terminal/session';
import { SessionTerminal } from './SessionTerminal';
import { FilePanel } from '../features/sftp/FilePanel';
import { Icon } from '../components/Icon';
import { ToolbarMenu } from '../components/ToolbarMenu';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';
import { TerminalSettings } from '../features/terminal/TerminalSettings';
import { CommandPanel } from '../features/terminal/CommandPanel';
import { StatusBadge, useProgramSummary } from '../features/terminal/StatusBadge';
import { useSignWaiting } from '../features/terminal/agentSign';
function DetachedProgramStatus({ session }: { session: TerminalSession }) {
  const summary = useProgramSummary(session.programStatus);
  const shown = useSignWaiting(session.agentSign, session.connectionId) ?? summary;
  return shown && <StatusBadge summary={shown} />;
}
export function DetachedWindow({ id }: { id: string }) {
  const theme = useTheme();
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [error, setError] = useState('');
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { fullscreen, toggleFullscreen } = useFullscreen(setError);
  // One pane is never a group of its own, but a group that reaches it still shows and can stop.
  const input = useInputScope(session ? [session.connectionId] : []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (e.code === 'F11') {
        e.preventDefault();
        e.stopPropagation();
        void toggleFullscreen();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyF') {
        e.preventDefault();
        e.stopPropagation();
        session?.view.set({ search: true });
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [toggleFullscreen, session]);
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
      <TitleBar title={session?.profile.name ?? '터미널 인계 중'} fail={setError}>
        {session && <DetachedProgramStatus session={session} />}
        <ToolbarMenu label="메뉴">
          <button aria-pressed={filesOpen} onClick={() => setFilesOpen((v) => !v)}>
            <Icon name="folder" size={16} />
            원격 파일
          </button>
          <button disabled={!session} onClick={() => session?.view.set({ search: true })}>
            터미널 검색
          </button>
          <button disabled={!session} onClick={() => session?.view.set({ log: true })}>
            세션 기록
          </button>
          <button onClick={() => setCommandsOpen(true)}>명령</button>
          <button onClick={() => setSettingsOpen(true)}>터미널 설정</button>
          <button onClick={() => void toggleFullscreen()}>
            {fullscreen ? '전체화면 종료' : '전체화면'}
          </button>
        </ToolbarMenu>
        <small className="title-note">독립 창 · 닫으면 이 연결 종료</small>
      </TitleBar>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <div className={`detached-grid ${filesOpen ? '' : 'files-hidden'}`}>
        {session && (
          <SessionTerminal
            session={session}
            active
            theme={theme}
            reconnect={() => setError('연결을 종료한 뒤 기본 창의 세션 목록에서 새로 연결하세요.')}
          />
        )}
        {filesOpen && <FilePanel session={session ?? undefined} />}
      </div>
      <StatusBar
        session={session ?? undefined}
        sending={input.sending}
        input={<InputScopeControl input={input} />}
      />
      {settingsOpen && <TerminalSettings close={() => setSettingsOpen(false)} />}
      {commandsOpen && (
        <CommandPanel
          sessions={session ? [session] : []}
          active={session?.tabId}
          close={() => setCommandsOpen(false)}
        />
      )}
    </div>
  );
}
