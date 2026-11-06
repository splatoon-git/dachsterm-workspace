import { FtpPane } from '../features/sftp/FtpPane';
import { useFullscreen } from './useFullscreen';
import { insertTab, paneCapacity } from './workspaceTabs';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { MaintenancePanel } from '../features/settings/MaintenancePanel';
import { SessionTransfer } from '../features/sessions/SessionTransfer';
import { BroadcastControl } from '../features/terminal/BroadcastControl';
import { VaultDialog, type VaultStatus } from '../features/sessions/VaultDialog';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTheme } from '../themes/useTheme';
import { ThemePicker } from '../themes/ThemePicker';
import {
  call,
  desktop,
  errorText,
  blankProfile,
  type Profile,
  type Snapshot,
  type Group,
} from '../lib/ipc';
import { SessionForm } from '../features/sessions/SessionForm';
import { SessionManager } from '../features/sessions/SessionManager';
import { groupPath, inGroup, matchesSession } from '../features/sessions/model';
import { TerminalSession, type LocalCatalog, type LocalTarget } from '../features/terminal/session';
import { PodTreeDialog } from '../features/terminal/PodTreeDialog';
import { SnippetDialog } from '../features/terminal/SnippetDialog';
import { CommandCatalog } from '../features/terminal/CommandGuide';
import { TerminalPane } from '../features/terminal/TerminalPane';
import { MonitorBar } from '../features/monitoring/MonitorBar';
import { TunnelPanel } from '../features/tunnels/TunnelPanel';
import { ResizeHandle } from '../components/ResizeHandle';
import type { CSSProperties } from 'react';
import { FilePanel } from '../features/sftp/FilePanel';
import { Icon } from '../components/Icon';
import { Dialog } from '../components/Dialog';
import { ToolbarMenu } from '../components/ToolbarMenu';
import face from '../assets/brand/dachshund-face.png';
import full from '../assets/brand/dachshund-full.png';
const TerminalPreview = lazy(() =>
  import('../features/terminal/TerminalPreview').then((m) => ({ default: m.TerminalPreview })),
);
const GamePane = lazy(() => import('../features/games/GamePane'));
import { games, type GameId } from '../features/games/catalog';
function subscribeNarrowViewport(listener: () => void) {
  const media = window.matchMedia('(max-width: 700px)');
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
function Tab({
  session,
  active,
  select,
  close,
}: {
  session: TerminalSession;
  active: boolean;
  select: () => void;
  close: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const labels: Record<string, string> = {
    connecting: '접속 중',
    authenticating: '인증 중',
    trust: '키 확인',
    connected: '연결됨',
    closed: '종료',
    error: '오류',
  };
  return (
    <div
      className={`session-tab ${active ? 'selected' : ''}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/dachsterm-tab', session.tabId)}
    >
      <button role="tab" aria-selected={active} onClick={select}>
        {session.profile.name}
        <small>{labels[state.status]}</small>
      </button>
      <button aria-label={`${session.profile.name} 탭 닫기`} onClick={close}>
        ×
      </button>
    </div>
  );
}
function ActiveStatus({ session }: { session: TerminalSession }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  return (
    <span>
      {session.localTarget
        ? session.localTarget.name
        : `${session.profile.username}@${session.profile.host}:${session.profile.port}`}{' '}
      · {state.message}
    </span>
  );
}
export function App() {
  const theme = useTheme();
  const narrow = useSyncExternalStore(subscribeNarrowViewport, () => window.innerWidth <= 700);
  const [snapshot, setSnapshot] = useState<Snapshot>({ profiles: [], groups: [] });
  const [localCatalog, setLocalCatalog] = useState<LocalCatalog>({ targets: [], warning: null });
  const [localLoading, setLocalLoading] = useState(desktop);
  const [localOpen, setLocalOpen] = useState(false);
  const [podtreeOpen, setPodtreeOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.innerWidth > 700 && localStorage.getItem('dachsterm.sidebar') !== 'false',
  );
  const [sidebarView, setSidebarView] = useState<'connections' | 'files'>(() =>
    localStorage.getItem('dachsterm.sidebarView') === 'files' ? 'files' : 'connections',
  );
  const closeDrawer = () => {
    if (window.innerWidth <= 700) setSidebarOpen(false);
  };
  const showSidebar = async (view: 'connections' | 'files', focusSearch = false) => {
    if (fullscreen) await toggleFullscreen();
    setSidebarView(view);
    setSidebarOpen(true);
    requestAnimationFrame(() => {
      if (focusSearch) searchInput.current?.focus();
      else document.getElementById(`sidebar-tab-${view}`)?.focus();
    });
  };
  const searchInput = useRef<HTMLInputElement>(null);
  const refreshLocal = useCallback(async () => {
    if (!desktop) return;
    setLocalLoading(true);
    try {
      setLocalCatalog(await call<LocalCatalog>('local_targets'));
    } catch (e) {
      setLocalCatalog((old) => ({ ...old, warning: errorText(e) }));
    } finally {
      setLocalLoading(false);
    }
  }, []);
  useEffect(() => {
    // Discovery is read-only and does not start a shell or a WSL distribution.
    void refreshLocal();
  }, [refreshLocal]);
  useEffect(() => {
    localStorage.setItem('dachsterm.sidebar', String(sidebarOpen));
  }, [sidebarOpen]);
  useEffect(() => {
    localStorage.setItem('dachsterm.sidebarView', sidebarView);
  }, [sidebarView]);
  const [broadcastIds, setBroadcastIds] = useState<string[]>([]);
  const [zoomed, setZoomed] = useState(false);
  const [tunnelsOpen, setTunnelsOpen] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [pendingVault, setPendingVault] = useState<{
    profile: Profile;
    existing?: TerminalSession;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [gameTabs, setGameTabs] = useState<GameId[]>([]);
  const [activeGame, setActiveGame] = useState<GameId | null>(null);
  const survivorClose = useRef<(() => boolean) | null>(null);
  const registerSurvivorClose = useCallback((close: (() => boolean) | null) => {
    survivorClose.current = close;
  }, []);
  const settleSurvivorBeforeClose = useCallback(() => {
    if (survivorClose.current && !survivorClose.current()) {
      setActiveGame('survivor');
      return false;
    }
    return true;
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (!settleSurvivorBeforeClose()) event.preventDefault();
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((e) => setError(errorText(e)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [settleSurvivorBeforeClose]);
  useEffect(() => {
    // Browser reload/close is best-effort; native close uses the cancellable handler above.
    const save = (event: BeforeUnloadEvent) => {
      if (!settleSurvivorBeforeClose()) event.preventDefault();
    };
    window.addEventListener('beforeunload', save);
    return () => window.removeEventListener('beforeunload', save);
  }, [settleSurvivorBeforeClose]);
  const tabStrip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabStrip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [activeGame]);
  const leaveGame = () => {
    setActiveGame(null);
    requestAnimationFrame(() => {
      tabStrip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    });
  };
  const openGame = (id: GameId) => {
    setGameTabs((previous) => (previous.includes(id) ? previous : [...previous, id]));
    setActiveGame(id);
    closeDrawer();
  };
  const closeGame = (id: GameId) => {
    if (id === 'survivor' && !settleSurvivorBeforeClose()) return;
    setGameTabs((previous) => previous.filter((game) => game !== id));
    if (activeGame === id) leaveGame();
  };
  const [error, setError] = useState('');
  const { fullscreen, toggleFullscreen } = useFullscreen(setError);
  const [form, setForm] = useState<Profile | null>(null);
  const [group, setGroup] = useState<Group | null>(null);
  const [remove, setRemove] = useState<Profile | null>(null);
  const [auth, setAuth] = useState<{ profile: Profile; session?: TerminalSession } | null>(null);
  const secret = useRef<HTMLInputElement>(null);
  const [tabs, setTabs] = useState<TerminalSession[]>([]);
  const [active, setActive] = useState('');
  const [preview, setPreview] = useState(false);
  const [layout, setLayout] = useState(() => localStorage.getItem('dachsterm.layout') ?? 'single');
  async function changeLayout(next: string) {
    try {
      if (desktop) await call('broadcast_set', { ids: [] });
      setBroadcastIds([]);
      setZoomed(false);
      setLayout(next);
    } catch (e) {
      setError(errorText(e));
    }
  }
  const [leftWidth, setLeftWidth] = useState(() =>
    Math.max(280, Math.min(420, Number(localStorage.getItem('dachsterm.leftWidth')) || 304)),
  );
  const [split, setSplit] = useState(50);
  useEffect(() => {
    localStorage.setItem('dachsterm.layout', layout);
    localStorage.setItem('dachsterm.leftWidth', String(leftWidth));
  }, [layout, leftWidth]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const refresh = useCallback(async () => {
    if (desktop) {
      try {
        const next = await call<Snapshot>('sessions');
        setSnapshot(next);
        if (next.credentialWarning) setError(next.credentialWarning);
      } catch (e) {
        setError(errorText(e));
      }
    }
  }, []);
  useEffect(() => {
    // SQLite is an external store; refresh sets state only after the IPC response.
    void refresh();
  }, [refresh]);
  async function action(command: string, args: Record<string, unknown>) {
    try {
      await call(command, args);
      await refresh();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }
  async function connect(
    profile: Profile,
    value: string | null,
    existing?: TerminalSession,
    remember = false,
  ) {
    if (value === null && profile.hasSecret) {
      try {
        const status = await call<VaultStatus>('vault_status');
        if (status.enabled && !status.unlocked) {
          setPendingVault({ profile, existing });
          setVaultOpen(true);
          return;
        }
      } catch (e) {
        setError(errorText(e));
        return;
      }
    }
    setPreview(false);
    setActiveGame(null);
    closeDrawer();
    if (existing) {
      void existing.reconnect(value, profile, remember);
      setActive(existing.tabId);
      return;
    }
    const session = new TerminalSession(profile, theme, () => void refresh());
    setTabs((previous) => insertTab(previous, session, layout));
    setActive(session.tabId);
    void session.connect(value, remember);
  }
  function openLocal(target: LocalTarget) {
    const profile = { ...blankProfile(), id: target.id, name: target.name, host: 'localhost' };
    const session = new TerminalSession(profile, theme, () => {}, target);
    setTabs((previous) => insertTab(previous, session, layout));
    setActive(session.tabId);
    setActiveGame(null);
    setPreview(false);
    setLocalOpen(false);
    closeDrawer();
    void session.connect(null);
  }
  const shortcut = useEffectEvent((e: KeyboardEvent) => {
    if (!document.querySelector('dialog[open]') && e.code === 'F11') {
      e.preventDefault();
      e.stopPropagation();
      void toggleFullscreen();
      return;
    }
    if (
      document.querySelector('dialog[open]') ||
      !(e.ctrlKey || e.metaKey) ||
      !e.shiftKey ||
      e.altKey
    )
      return;
    switch (e.code) {
      case 'Enter':
        e.preventDefault();
        if (tabs.length > 1 && layout !== 'single') setZoomed((v) => !v);
        break;
      case 'KeyL':
        e.preventDefault();
        setLocalOpen(true);
        break;
      case 'KeyN':
        e.preventDefault();
        setForm(blankProfile());
        break;
      case 'KeyB':
        e.preventDefault();
        if (fullscreen) void showSidebar(sidebarView);
        else setSidebarOpen((v) => !v);
        break;
      case 'KeyF':
        e.preventDefault();
        void showSidebar('connections', true);
        break;
      case 'KeyE':
        e.preventDefault();
        showSidebar('files');
        break;
      default:
        return;
    }
    e.stopPropagation();
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => shortcut(e);
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);
  function requestConnect(profile: Profile, existing?: TerminalSession) {
    if (existing?.podtree) {
      setPodtreeOpen(true);
      return;
    }
    if (existing?.localTarget) {
      void existing.reconnect(null, profile);
      return;
    }
    if (profile.hasSecret || ['agent', 'interactive'].includes(profile.auth))
      connect(profile, null, existing);
    else setAuth({ profile, session: existing });
  }
  async function detach(session: TerminalSession) {
    try {
      await call('detach_terminal', {
        id: session.connectionId,
        profile: session.profile,
        cols: session.terminal.cols,
        rows: session.terminal.rows,
      });
      session.release();
      setTabs((previous) => previous.filter((t) => t !== session));
      if (active === session.tabId) setActive(tabs.find((t) => t !== session)?.tabId ?? '');
    } catch (e) {
      setError(errorText(e));
    }
  }
  function closeTab(session: TerminalSession) {
    session.dispose();
    setTabs((previous) => previous.filter((t) => t !== session));
    if (active === session.tabId) setActive(tabs.find((t) => t !== session)?.tabId ?? '');
  }
  const selected = tabs.find((t) => t.tabId === active);
  const fileSession =
    !selected?.podtree && !selected?.localTarget && selected?.profile.protocol === 'ssh'
      ? selected
      : undefined;
  const profiles = snapshot.profiles
    .filter((p) => {
      const match = matchesSession(p, query, snapshot.groups);
      return (
        match &&
        (filter === 'all' ||
          (filter === 'favorite' && p.favorite) ||
          (filter === 'recent' && p.lastConnected) ||
          inGroup(p, filter, snapshot.groups))
      );
    })
    .sort((a, b) =>
      filter === 'recent'
        ? (b.lastConnected ?? 0) - (a.lastConnected ?? 0)
        : (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name),
    );
  return (
    <div className={`app-shell ${fullscreen ? 'terminal-fullscreen' : ''}`}>
      <a className="skip-link" href="#workspace">
        작업 영역으로 이동
      </a>
      {fullscreen && (!tabs.length || activeGame) && (
        <button className="fullscreen-exit" onClick={() => void toggleFullscreen()}>
          전체화면 종료 · F11
        </button>
      )}
      <header className="toolbar">
        <div className="brand">
          <img src={face} alt="" width="32" height="32" />
          <strong>DachsTerm</strong>
          <span className="phase-badge">DESKTOP</span>
        </div>
        <div className="tools">
          <button
            aria-label="사이드바"
            title="사이드바 · Ctrl/Cmd+Shift+B"
            aria-expanded={sidebarOpen}
            aria-controls="workspace-sidebar"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            ☰
          </button>
          <button onClick={() => setLocalOpen(true)} title="로컬 터미널 · Ctrl/Cmd+Shift+L">
            <Icon name="terminal" size={16} />
            로컬 터미널
          </button>
          <ToolbarMenu label="보기">
            <button
              aria-pressed={sidebarOpen && sidebarView === 'files'}
              onClick={() => showSidebar('files')}
            >
              <Icon name="folder" size={16} /> 파일
            </button>
            <button
              onClick={() => {
                setActiveGame(null);
                setPreview((value) => !value);
              }}
            >
              {preview ? '작업 화면' : '터미널 미리보기'}
            </button>
            <button onClick={() => setHelpOpen(true)}>키보드 단축키</button>
          </ToolbarMenu>
          <ToolbarMenu label="도구">
            <button onClick={() => setSnippetsOpen(true)}>스니펫</button>
            <button onClick={() => setCommandsOpen(true)}>기본 명령·로그 필터</button>
            <button onClick={() => setPodtreeOpen(true)}>PodTree 열기</button>
            <button onClick={() => setTunnelsOpen(true)}>
              <Icon name="tunnel" size={16} />
              터널
            </button>
          </ToolbarMenu>
          <button aria-label="설정" title="설정" onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" size={16} />
          </button>
          <button
            className="primary"
            aria-label="＋ 새 연결"
            onClick={() => setForm(blankProfile())}
          >
            <Icon name="plus" size={16} /> <span>새 연결</span>
          </button>
        </div>
      </header>
      {error && (
        <div className="app-error" role="alert">
          {error}
          <button onClick={() => setError('')} aria-label="오류 닫기">
            ×
          </button>
        </div>
      )}
      <div
        className={`workspace-grid unified-workspace ${sidebarOpen ? '' : 'sidebar-hidden'}`}
        style={
          {
            '--sidebar-width': `${leftWidth}px`,
          } as CSSProperties
        }
      >
        {sidebarOpen && (
          <button
            className="sidebar-backdrop"
            aria-label="사이드바 닫기"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <div
          id="workspace-sidebar"
          className="workspace-sidebar"
          hidden={!sidebarOpen}
          onKeyDown={(e) => {
            if (
              e.key === 'Escape' &&
              window.innerWidth <= 700 &&
              !document.querySelector('dialog[open]')
            ) {
              e.stopPropagation();
              setSidebarOpen(false);
              document
                .querySelector<HTMLButtonElement>('button[aria-controls="workspace-sidebar"]')
                ?.focus();
            }
          }}
        >
          <div
            className="sidebar-switcher"
            role="tablist"
            aria-label="사이드바 보기"
            onKeyDown={(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
              e.preventDefault();
              const view =
                e.key === 'Home'
                  ? 'connections'
                  : e.key === 'End'
                    ? 'files'
                    : sidebarView === 'files'
                      ? 'connections'
                      : 'files';
              setSidebarView(view);
              document.getElementById(`sidebar-tab-${view}`)?.focus();
            }}
          >
            {(['connections', 'files'] as const).map((view) => (
              <button
                key={view}
                id={`sidebar-tab-${view}`}
                role="tab"
                aria-selected={sidebarView === view}
                aria-controls={view === 'connections' ? 'session-sidebar' : 'file-sidebar'}
                tabIndex={sidebarView === view ? 0 : -1}
                onClick={() => setSidebarView(view)}
              >
                <Icon name={view === 'connections' ? 'server' : 'folder'} size={16} />
                {view === 'connections' ? '연결' : '원격 파일'}
              </button>
            ))}
          </div>
          <aside
            id="session-sidebar"
            className="sessions"
            aria-label="세션 탐색"
            hidden={sidebarView !== 'connections'}
          >
            <div className="panel-title">
              <h2>워크스페이스</h2>
              <span className="count">{snapshot.profiles.length}</span>
            </div>
            <label className="search">
              <span>세션 검색</span>
              <input
                ref={searchInput}
                type="search"
                placeholder="이름 또는 호스트 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="connections-scroll">
              <section className="local-targets" aria-label="로컬 환경">
                <div className="group-heading">
                  <span>로컬 터미널</span>
                  <button
                    aria-label="로컬 환경 새로고침"
                    disabled={!desktop || localLoading}
                    onClick={() => void refreshLocal()}
                  >
                    ↻
                  </button>
                </div>
                {localLoading && <p role="status">로컬 환경 탐색 중…</p>}
                {!desktop && <p>데스크톱 앱에서 자동 탐색합니다.</p>}
                {localCatalog.targets.map((target) => (
                  <button
                    key={target.id}
                    className="nav-item local-target"
                    onClick={() => openLocal(target)}
                    title={`${target.name} 새 터미널 열기`}
                  >
                    <Icon name="terminal" size={15} />
                    <span>{target.name}</span>
                    <small>{target.kind === 'wsl' ? 'WSL' : '로컬'}</small>
                  </button>
                ))}
                {localCatalog.warning && <p role="status">{localCatalog.warning}</p>}
              </section>
              <div className="group-heading">
                <span>저장된 연결</span>
                <button aria-label="서버 추가" onClick={() => setForm(blankProfile())}>
                  ＋
                </button>
              </div>

              <nav aria-label="세션 분류">
                <div className="session-filters">
                  {[
                    ['all', '전체'],
                    ['favorite', '즐겨찾기'],
                    ['recent', '최근'],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      className="nav-item"
                      aria-current={filter === id ? 'page' : undefined}
                      onClick={() => setFilter(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="group-heading">
                  <span>그룹</span>
                  <button aria-label="그룹 추가" onClick={() => setGroup({ id: '', name: '' })}>
                    ＋
                  </button>
                </div>
                {snapshot.groups.map((g) => (
                  <div className="group-row" key={g.id}>
                    <button
                      className="nav-item"
                      aria-current={filter === g.id ? 'page' : undefined}
                      onClick={() => setFilter(g.id)}
                    >
                      ▱ {groupPath(g.id, snapshot.groups)}
                    </button>
                    <button aria-label={`${g.name} 그룹 수정`} onClick={() => setGroup(g)}>
                      ⋯
                    </button>
                  </div>
                ))}
              </nav>
              <div className="session-list">
                {profiles.length ? (
                  profiles.map((p) => (
                    <article key={p.id} className="profile-card">
                      <button
                        className="profile-target"
                        onDoubleClick={() => requestConnect(p)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') requestConnect(p);
                        }}
                        title="더블클릭 또는 Enter로 연결"
                      >
                        <strong>
                          {p.favorite ? '★ ' : ''}
                          {p.name}
                        </strong>
                        <span>
                          {p.username}@{p.host}:{p.port}
                        </span>
                        {filter === 'recent' && p.lastConnected && (
                          <small>{new Date(p.lastConnected * 1000).toLocaleString()}</small>
                        )}
                      </button>
                      <div className="profile-actions">
                        <button onClick={() => requestConnect(p)}>연결</button>
                        <button onClick={() => setForm(p)}>수정</button>
                        <details>
                          <summary aria-label={`${p.name} 추가 작업`}>⋯</summary>
                          <button
                            onClick={() =>
                              void action('save_session', {
                                profile: { ...p, favorite: !p.favorite },
                                secretAction: 'keep',
                                secret: null,
                              })
                            }
                          >
                            {p.favorite ? '즐겨찾기 해제' : '즐겨찾기'}
                          </button>
                          <button onClick={() => void action('duplicate_session', { id: p.id })}>
                            복제
                          </button>
                          <button onClick={() => setRemove(p)}>삭제</button>
                        </details>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="sidebar-empty">
                    {query ? '검색 결과가 없습니다.' : '등록된 서버가 없습니다.'}
                    <p>새 연결에서 서버를 등록하세요.</p>
                  </div>
                )}
              </div>
              <details className="sidebar-games">
                <summary>게임</summary>
                <nav aria-label="게임 목록">
                  {games.map((game) => (
                    <button
                      key={game.id}
                      className="nav-item"
                      aria-current={activeGame === game.id ? 'page' : undefined}
                      onClick={() => openGame(game.id)}
                    >
                      <Icon name="terminal" size={14} />
                      {game.title}
                    </button>
                  ))}
                </nav>
              </details>
            </div>
            <div className="local-note">
              <span className="status-dot" />
              로컬 워크스페이스
            </div>
          </aside>
          <div
            id="file-sidebar"
            className="sidebar-file-panel"
            role="tabpanel"
            aria-labelledby="sidebar-tab-files"
            hidden={sidebarView !== 'files'}
          >
            {selected?.localTarget || (selected && selected.profile.protocol !== 'ssh') ? (
              <div className="file-empty">
                <Icon name="folder" size={32} />
                <h3>{selected.localTarget ? '로컬 터미널 사용 중' : '파일 작업 탭 사용 중'}</h3>
                <p>
                  {selected.localTarget
                    ? '원격 파일은 SSH 연결을 선택하면 표시됩니다.'
                    : '이 연결의 파일은 중앙 작업 탭에서 탐색할 수 있습니다.'}
                </p>
                <button onClick={() => setSidebarView('connections')}>연결 목록 보기</button>
              </div>
            ) : (
              <FilePanel session={fileSession} />
            )}
          </div>
        </div>
        {sidebarOpen && (
          <ResizeHandle
            value={leftWidth}
            min={280}
            max={420}
            onChange={setLeftWidth}
            label="사이드바 너비"
          />
        )}
        <main id="workspace" tabIndex={-1} inert={narrow && sidebarOpen && !fullscreen}>
          <div
            className="tab-strip"
            ref={tabStrip}
            role="tablist"
            aria-label="터미널 탭"
            onKeyDown={(e) => {
              if (
                !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) ||
                (e.target as HTMLElement).getAttribute('role') !== 'tab'
              )
                return;
              const buttons = Array.from(
                e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
              );
              const index = buttons.indexOf(e.target as HTMLButtonElement);
              const next =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? buttons.length - 1
                    : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
              e.preventDefault();
              buttons[next]?.click();
              buttons[next]?.focus();
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/dachsterm-tab');
              const t = tabs.find((t) => t.tabId === id);
              if (t) {
                setTabs([t, ...tabs.filter((v) => v !== t)]);
                setActive(id);
                setActiveGame(null);
              }
            }}
          >
            {tabs.length ? (
              tabs.map((t) => (
                <Tab
                  key={t.tabId}
                  session={t}
                  active={active === t.tabId && !preview && !activeGame}
                  select={() => {
                    setActive(t.tabId);
                    setActiveGame(null);
                    if (layout !== 'single' && tabs.indexOf(t) >= paneCapacity(layout))
                      setTabs([t, ...tabs.filter((v) => v !== t)]);
                    setPreview(false);
                  }}
                  close={() => closeTab(t)}
                />
              ))
            ) : (
              <div className={`session-tab ${!activeGame ? 'selected' : ''}`}>
                <button role="tab" aria-selected={!activeGame} onClick={leaveGame}>
                  {preview ? '터미널 미리보기' : '시작하기'}
                </button>
              </div>
            )}
            {preview && tabs.length > 0 && (
              <div className={`session-tab ${!activeGame ? 'selected' : ''}`}>
                <button role="tab" aria-selected={!activeGame} onClick={leaveGame}>
                  터미널 미리보기
                </button>
              </div>
            )}
            {gameTabs.map((id) => (
              <div key={id} className={`session-tab ${activeGame === id ? 'selected' : ''}`}>
                <button
                  role="tab"
                  id={`game-tab-${id}`}
                  aria-controls={`game-panel-${id}`}
                  aria-selected={activeGame === id}
                  onClick={() => setActiveGame(id)}
                >
                  {games.find((game) => game.id === id)?.title}
                </button>
                <button
                  aria-label={`${games.find((game) => game.id === id)?.title} 탭 닫기`}
                  onClick={() => closeGame(id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {preview && (
            <div className="preview-wrap" hidden={!!activeGame} inert={!!activeGame}>
              <div className="preview-notice">색상과 한글 렌더링 미리보기 · SSH 연결 없음</div>
              <Suspense fallback={<p>터미널 준비 중…</p>}>
                <TerminalPreview theme={theme} />
              </Suspense>
            </div>
          )}
          {tabs.length > 0 && !activeGame && (
            <div className="workspace-controls">
              <button
                className="detach-button"
                aria-label="새 창으로 분리 ↗"
                disabled={
                  !!selected?.podtree ||
                  !!selected?.localTarget ||
                  selected?.profile.protocol !== 'ssh'
                }
                title={
                  selected?.localTarget
                    ? '로컬 터미널은 현재 창의 탭과 분할을 지원합니다.'
                    : '새 창으로 분리'
                }
                onClick={() => selected && void detach(selected)}
              >
                ↗
              </button>
              <div className="segmented" aria-label="터미널 배치">
                {[
                  ['single', '단일'],
                  ['columns', '좌우'],
                  ['rows', '상하'],
                  ['grid', '2 × 2'],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    aria-pressed={layout === key}
                    onClick={() => void changeLayout(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <BroadcastControl
                enabled={layout !== 'single' && tabs.length > 1}
                scope={tabs.slice(0, paneCapacity(layout)).map((t) => t.connectionId)}
                onSelectionChange={setBroadcastIds}
              />
              <button
                disabled={layout === 'single' || tabs.length < 2}
                aria-pressed={zoomed}
                title="선택 터미널 확대 · Ctrl/Cmd+Shift+Enter"
                onClick={() => setZoomed((v) => !v)}
              >
                {zoomed ? '분할 복원' : '선택 창 확대'}
              </button>
              <button
                aria-pressed={fullscreen}
                title="전체화면 · F11"
                onClick={() => void toggleFullscreen()}
              >
                {fullscreen ? '전체화면 종료' : '전체화면'}
              </button>
              {layout !== 'single' && (
                <label className="split-ratio">
                  분할 비율
                  <input
                    type="range"
                    min="25"
                    max="75"
                    value={split}
                    onChange={(e) => setSplit(Number(e.target.value))}
                  />
                </label>
              )}
            </div>
          )}
          <div
            className={`terminal-grid layout-${layout}`}
            data-pane-count={zoomed ? 1 : Math.min(tabs.length, paneCapacity(layout))}
            hidden={!tabs.length || preview || !!activeGame}
            inert={!!activeGame}
            style={{ '--split-ratio': `${split}%` } as CSSProperties}
          >
            {tabs.map((t, index) => (
              <div
                className={`pane-cell ${active === t.tabId ? 'focused' : ''} ${broadcastIds.includes(t.connectionId) ? 'broadcast-target' : ''}`}
                key={t.tabId}
                hidden={
                  preview ||
                  (layout === 'single' || zoomed
                    ? active !== t.tabId
                    : index >= paneCapacity(layout))
                }
                onFocusCapture={() => setActive(t.tabId)}
                onPointerDown={() => setActive(t.tabId)}
              >
                {t.profile.protocol && t.profile.protocol !== 'ssh' ? (
                  <FtpPane
                    session={t}
                    reconnect={() =>
                      requestConnect(
                        snapshot.profiles.find((p) => p.id === t.profile.id) ?? t.profile,
                        t,
                      )
                    }
                  />
                ) : (
                  <TerminalPane
                    key={t.tabId}
                    session={t}
                    focused={active === t.tabId && !preview && !activeGame}
                    active={
                      !preview &&
                      !activeGame &&
                      (layout === 'single' || zoomed
                        ? active === t.tabId
                        : index < paneCapacity(layout))
                    }
                    theme={theme}
                    reconnect={() =>
                      requestConnect(
                        snapshot.profiles.find((p) => p.id === t.profile.id) ?? t.profile,
                        t,
                      )
                    }
                  />
                )}
              </div>
            ))}
          </div>
          {!tabs.length && !preview && !activeGame && (
            <section className="welcome">
              <div className="welcome-topline">
                <span>WORKSPACE / OVERVIEW</span>
                <span>안전한 로컬 작업 공간</span>
              </div>
              <div className="welcome-hero">
                <div className="welcome-copy">
                  <span className="eyebrow">A LITTLE COMPANION. A BETTER WORKFLOW.</span>
                  <h1>서버 작업의 편안한 시작</h1>
                  <p>
                    터미널부터 파일까지, 한 곳에서.
                    <br />
                    자주 쓰는 서버를 연결하고 작업에 집중하세요.
                  </p>
                  <button className="primary" onClick={() => setForm(blankProfile())}>
                    <Icon name="plus" size={17} />새 SSH 연결
                  </button>
                </div>
                <img className="mascot" src={full} alt="장모 크림 닥스훈트 마스코트" />
              </div>
              <div className="welcome-section-title">
                <h2>빠르게 시작하기</h2>
                <span>내 도구, 내 서버</span>
              </div>
              <div className="quick-actions">
                <button onClick={() => setForm(blankProfile())}>
                  <Icon name="server" size={23} />
                  <strong>서버 연결</strong>
                  <span>새 SSH 세션 등록</span>
                  <Icon name="arrow" size={16} />
                </button>
                <button onClick={() => setLocalOpen(true)}>
                  <Icon name="terminal" size={23} />
                  <strong>로컬 터미널 열기</strong>
                  <span>이 컴퓨터의 셸 · WSL</span>
                  <Icon name="arrow" size={16} />
                </button>
                <button
                  onClick={() => {
                    setFilter('recent');
                    showSidebar('connections');
                  }}
                >
                  <Icon name="activity" size={23} />
                  <strong>최근 작업</strong>
                  <span>사용했던 서버 찾기</span>
                  <Icon name="arrow" size={16} />
                </button>
              </div>
              <div className="welcome-section-title">
                <h2>연결 워크플로</h2>
                <span>SSH · SFTP · 멀티 터미널</span>
              </div>
              <div className="workflow-note">
                <span className="step-number">01</span>
                <div>
                  <strong>연결할 서버를 등록하세요</strong>
                  <p>호스트와 계정을 저장하고, 지문을 확인하면 준비 끝.</p>
                </div>
                <Icon name="chevron" size={18} />
              </div>
              <div className="workflow-note">
                <span className="step-number">02</span>
                <div>
                  <strong>작업에 맞게 공간을 나누세요</strong>
                  <p>여러 터미널과 원격 파일을 함께 보며 작업하세요.</p>
                </div>
                <Icon name="chevron" size={18} />
              </div>
              <small>
                {desktop
                  ? '비밀번호 · 개인키 인증 지원'
                  : '실제 접속과 저장은 데스크톱 앱에서 사용할 수 있습니다.'}
              </small>
            </section>
          )}
          {gameTabs.map((game) => (
            <Suspense key={game} fallback={activeGame === game ? <p>준비 중…</p> : null}>
              <GamePane
                game={game}
                active={activeGame === game}
                leave={leaveGame}
                registerSurvivorClose={registerSurvivorClose}
              />
            </Suspense>
          ))}
          {!activeGame &&
            selected &&
            !selected.podtree &&
            !selected.localTarget &&
            selected.profile.protocol === 'ssh' && (
              <MonitorBar key={selected.connectionId} session={selected} />
            )}
        </main>
      </div>
      <footer>
        {activeGame ? (
          <span>로컬 · {games.find((game) => game.id === activeGame)?.title}</span>
        ) : selected ? (
          <ActiveStatus session={selected} />
        ) : (
          <span>
            <span className="status-dot" />
            연결 없음
          </span>
        )}
        <span>DachsTerm · 로컬</span>
      </footer>
      {snippetsOpen && (
        <SnippetDialog
          sessions={tabs}
          active={activeGame ? undefined : active}
          close={() => setSnippetsOpen(false)}
        />
      )}
      {commandsOpen && <CommandCatalog close={() => setCommandsOpen(false)} />}
      {podtreeOpen && (
        <PodTreeDialog
          sessions={tabs}
          locals={localCatalog.targets}
          close={() => setPodtreeOpen(false)}
          open={(launch, title) => {
            const profile = { ...blankProfile(), name: `PodTree · ${launch.context}`, host: title };
            const session = new TerminalSession(profile, theme, () => {}, undefined, launch);
            setTabs((previous) => insertTab(previous, session, layout));
            setActive(session.tabId);
            setActiveGame(null);
            setPreview(false);
            setPodtreeOpen(false);
            closeDrawer();
            void session.connect(null);
          }}
        />
      )}
      {localOpen && (
        <Dialog title="로컬 터미널 열기" close={() => setLocalOpen(false)}>
          <p className="muted">
            서버 등록 없이 이 컴퓨터에서 셸을 시작합니다. WSL은 선택한 배포판의 기본 사용자로
            열립니다.
          </p>
          {localLoading && <p role="status">로컬 환경 탐색 중…</p>}
          {!desktop && (
            <p>데스크톱 앱에서 PowerShell·WSL 또는 macOS 기본 셸을 자동으로 찾습니다.</p>
          )}
          <div className="local-picker">
            {localCatalog.targets.map((target) => (
              <button key={target.id} onClick={() => openLocal(target)}>
                <Icon name="terminal" size={18} />
                <strong>{target.name}</strong>
                <span>{target.kind === 'wsl' ? 'WSL 배포판' : '로컬 셸'}</span>
              </button>
            ))}
          </div>
          {localCatalog.warning && <p role="status">{localCatalog.warning}</p>}
          {!localLoading && desktop && !localCatalog.targets.length && (
            <p>발견된 셸이 없습니다. 설치 상태를 확인하고 새로고침하세요.</p>
          )}
          <button disabled={!desktop || localLoading} onClick={() => void refreshLocal()}>
            목록 새로고침
          </button>
        </Dialog>
      )}
      {helpOpen && (
        <Dialog title="키보드 단축키" close={() => setHelpOpen(false)}>
          <p className="muted">
            macOS에서는 Ctrl 대신 Command를 사용하세요. 대화상자에서는 전역 단축키가 실행되지
            않습니다.
          </p>
          <dl className="shortcut-list">
            <dt>새 연결</dt>
            <dd>Ctrl + Shift + N</dd>
            <dt>로컬 터미널</dt>
            <dd>Ctrl + Shift + L</dd>
            <dt>사이드바 접기 / 펼치기</dt>
            <dd>Ctrl + Shift + B</dd>
            <dt>세션 검색</dt>
            <dd>Ctrl + Shift + F</dd>
            <dt>원격 파일</dt>
            <dd>Ctrl + Shift + E</dd>
            <dt>전체화면 / 종료</dt>
            <dd>F11</dd>
            <dt>선택 터미널 확대 / 분할 복원</dt>
            <dd>Ctrl + Shift + Enter</dd>
            <dt>탭 이동 (탭에 포커스)</dt>
            <dd>← / → · Home / End</dd>
            <dt>터미널 복사 / 붙여넣기</dt>
            <dd>Ctrl + Shift + C / V · Shift + Insert</dd>
            <dt>TUI 마우스 모드에서 선택 / 붙여넣기</dt>
            <dd>Shift + 드래그 / 우클릭</dd>
            <dt>메뉴 / 대화상자 닫기</dt>
            <dd>Esc</dd>
          </dl>
        </Dialog>
      )}
      {tunnelsOpen && (
        <TunnelPanel
          session={selected?.podtree || selected?.localTarget ? undefined : selected}
          sessions={tabs}
          profiles={snapshot.profiles}
          close={() => setTunnelsOpen(false)}
        />
      )}
      {vaultOpen && (
        <VaultDialog
          close={() => {
            setVaultOpen(false);
            setPendingVault(null);
          }}
          unlocked={
            pendingVault
              ? () => {
                  void connect(pendingVault.profile, null, pendingVault.existing);
                }
              : undefined
          }
        />
      )}
      {settingsOpen && (
        <Dialog
          title="워크스페이스 설정"
          className="settings-dialog"
          close={() => setSettingsOpen(false)}
        >
          <ThemePicker />
          <section className="settings-data">
            <h3>암호 보관함</h3>
            <div className="form-actions">
              <button onClick={() => setVaultOpen(true)}>마스터 패스워드 · 암호 보관함</button>
            </div>
            <p className="muted">패널 배치와 분할 방식은 자동 저장됩니다.</p>
          </section>
          <SessionManager snapshot={snapshot} changed={() => void refresh()} />
          <SessionTransfer changed={() => void refresh()} profiles={snapshot.profiles} />
          <MaintenancePanel restored={() => void refresh()} />
        </Dialog>
      )}
      {form && (
        <SessionForm
          initial={form}
          profiles={snapshot.profiles}
          groups={snapshot.groups}
          close={() => setForm(null)}
          saved={(p, start, value) => {
            setForm(null);
            void refresh();
            if (start) {
              if (value !== null || p.hasSecret || p.auth !== 'password') connect(p, value);
              else requestConnect(p);
            }
          }}
        />
      )}
      {auth && (
        <Dialog title={`${auth.profile.name} 인증`} close={() => setAuth(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const value = secret.current?.value ?? '';
              if (secret.current) secret.current.value = '';
              const remember = new FormData(e.currentTarget).get('rememberSecret') === 'on';
              connect(auth.profile, value, auth.session, remember);
              setAuth(null);
            }}
          >
            <label>
              {auth.profile.auth === 'key' ? 'Passphrase (없으면 비워 두세요)' : '비밀번호'}
              <input ref={secret} type="password" autoComplete="off" autoFocus maxLength={16384} />
            </label>
            <label className="checkbox">
              <input type="checkbox" name="rememberSecret" />
              로그인 성공 후 이 세션의 암호 저장
            </label>
            <p className="muted">
              선택하면 보안 저장소에 보관하고 다음 접속에 사용합니다. 선택하지 않으면 이번 연결에만
              사용합니다. OTP·추가 인증 응답은 저장하지 않습니다.
            </p>
            <div className="form-actions">
              <button type="button" onClick={() => setAuth(null)}>
                취소
              </button>
              <button className="primary">연결</button>
            </div>
          </form>
        </Dialog>
      )}
      {group && (
        <Dialog title="그룹 관리" close={() => setGroup(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action('group_update', {
                group: {
                  ...group,
                  id: group.id || crypto.randomUUID(),
                  parentId: group.parentId ?? null,
                  sortOrder: group.sortOrder ?? 0,
                },
              }).then((ok) => {
                if (ok) setGroup(null);
              });
            }}
          >
            <label>
              그룹 이름
              <input
                autoFocus
                required
                maxLength={100}
                value={group.name}
                onChange={(e) => setGroup({ ...group, name: e.target.value })}
              />
            </label>
            <label>
              상위 그룹
              <select
                value={group.parentId ?? ''}
                onChange={(e) => setGroup({ ...group, parentId: e.target.value || null })}
              >
                <option value="">최상위</option>
                {snapshot.groups
                  .filter((g) => g.id !== group.id)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {groupPath(g.id, snapshot.groups)}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              그룹 정렬 순서
              <input
                type="number"
                value={group.sortOrder ?? 0}
                onChange={(e) => setGroup({ ...group, sortOrder: Number(e.target.value) })}
              />
            </label>
            <p className="muted">
              삭제 미리보기: 이 그룹의 직속 세션{' '}
              {snapshot.profiles.filter((p) => p.groupId === group.id).length}개와 직속 하위 그룹{' '}
              {snapshot.groups.filter((g) => g.parentId === group.id).length}개를 최상위로
              이동합니다. 하위 그룹의 세션과 열린 연결은 유지됩니다.
            </p>
            <div className="form-actions">
              {group.id && (
                <button
                  type="button"
                  onClick={() =>
                    void action('save_group', { id: group.id, name: null }).then((ok) => {
                      if (ok) {
                        setGroup(null);
                        setFilter('all');
                      }
                    })
                  }
                >
                  그룹 삭제
                </button>
              )}
              <button className="primary">저장</button>
            </div>
          </form>
        </Dialog>
      )}
      {remove && (
        <Dialog title="세션 삭제" close={() => setRemove(null)}>
          <p>{remove.name} 세션과 OS 저장소의 인증정보를 삭제합니다. 열린 연결은 유지됩니다.</p>
          <div className="form-actions">
            <button onClick={() => setRemove(null)}>취소</button>
            <button
              onClick={() =>
                void action('delete_session', { id: remove.id }).then((ok) => {
                  if (ok) setRemove(null);
                })
              }
            >
              세션 삭제
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
