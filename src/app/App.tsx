import { FtpPane } from '../features/sftp/FtpPane';
import { ShortcutList } from './ShortcutList';
import { useFullscreen } from './useFullscreen';
import { Welcome } from './Welcome';
import { PlainTab } from './GroupTabBar';
import {
  focusActiveTerminal,
  focusSelectedTab,
  WorkspaceGrid,
  type CellState,
} from './WorkspaceGrid';
import { useWorkspaceLayout, type Beside } from './useWorkspaceLayout';
import { useTabMenu } from './useTabMenu';
import { StatusBar } from './StatusBar';
import {
  allTabs,
  groups,
  tabKey,
  type GroupNode,
  type Preset,
  type Side,
  type TabRef,
} from './workspaceLayout';
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
import { SessionTerminal } from './SessionTerminal';
import { tmuxCloseNotice } from './tmuxNotice';
import { TunnelPanel } from '../features/tunnels/TunnelPanel';
import { ResizeHandle } from '../components/ResizeHandle';
import { SessionTab } from './SessionTab';
import { ProfileList } from '../features/sessions/ProfileList';
import { capabilities } from '../features/terminal/sessionKind';
import { TerminalSettings } from '../features/terminal/TerminalSettings';
import type { CSSProperties } from 'react';
import { SidebarFiles } from '../features/sftp/SidebarFiles';
import { Icon } from '../components/Icon';
import { Dialog } from '../components/Dialog';
import { ToolbarMenu } from '../components/ToolbarMenu';
import { anchorBelow, ContextMenu, type MenuPoint } from '../components/ContextMenu';
import { TitleBar } from './TitleBar';
import { SidebarRail } from './SidebarRail';
const TerminalPreview = lazy(() =>
  import('../features/terminal/TerminalPreview').then((m) => ({ default: m.TerminalPreview })),
);
const GamePane = lazy(() => import('../features/games/GamePane'));
import { games, type GameId } from '../features/games/catalog';
const sessionRef = (session: TerminalSession): TabRef => ({
  kind: 'session',
  tabId: session.tabId,
});
const sessionKey = (session: TerminalSession) => tabKey(sessionRef(session));
const presets: [Preset, string][] = [
  ['columns', '모든 탭 좌우'],
  ['rows', '모든 탭 상하'],
  ['grid', '모든 탭 2 × 2'],
  ['single', '모든 탭 하나로'],
];
const focusKeys: Record<string, Side> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'top',
  ArrowDown: 'bottom',
};
function subscribeNarrowViewport(listener: () => void) {
  const media = window.matchMedia('(max-width: 700px)');
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
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
  const [newMenu, setNewMenu] = useState<MenuPoint | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.innerWidth > 700 && localStorage.getItem('dachsterm.sidebar') !== 'false',
  );
  // No tab survives a restart, so the file view would open empty.
  const [sidebarView, setSidebarView] = useState<'connections' | 'files'>('connections');
  const closeDrawer = () => {
    if (window.innerWidth <= 700) setSidebarOpen(false);
  };
  // A new SSH connection shows its files, but a drawer must not cover a narrow window's terminal.
  const revealFiles = () => {
    setSidebarView('files');
    if (window.innerWidth > 700) setSidebarOpen(true);
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
  const [broadcastIds, setBroadcastIds] = useState<string[]>([]);
  const workspace = useWorkspaceLayout();
  const { open: openWorkspaceTab } = workspace;
  const [tunnelsOpen, setTunnelsOpen] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [pendingVault, setPendingVault] = useState<{
    profile: Profile;
    existing?: TerminalSession;
    beside?: Beside;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<'' | 'workspace' | 'terminal'>('');
  const [gameTabs, setGameTabs] = useState<GameId[]>([]);
  const survivorClose = useRef<(() => boolean) | null>(null);
  const registerSurvivorClose = useCallback((close: (() => boolean) | null) => {
    survivorClose.current = close;
  }, []);
  const settleSurvivorBeforeClose = useCallback(() => {
    if (survivorClose.current && !survivorClose.current()) {
      openWorkspaceTab({ kind: 'game', id: 'survivor' });
      return false;
    }
    return true;
  }, [openWorkspaceTab]);
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
  const leaveGame = (id: GameId) => {
    workspace.leaveTab(tabKey({ kind: 'game', id }));
    focusSelectedTab();
  };
  const openGame = (id: GameId) => {
    setGameTabs((previous) => (previous.includes(id) ? previous : [...previous, id]));
    workspace.open({ kind: 'game', id });
    closeDrawer();
  };
  const closeGame = (id: GameId) => {
    if (id === 'survivor' && !settleSurvivorBeforeClose()) return;
    setGameTabs((previous) => previous.filter((game) => game !== id));
    workspace.close(tabKey({ kind: 'game', id }));
    if (activeGame === id) focusSelectedTab();
  };
  const [error, setError] = useState('');
  const { fullscreen, toggleFullscreen } = useFullscreen(setError);
  const [form, setForm] = useState<Profile | null>(null);
  const [group, setGroup] = useState<Group | null>(null);
  const [remove, setRemove] = useState<Profile | null>(null);
  const [auth, setAuth] = useState<{
    profile: Profile;
    session?: TerminalSession;
    beside?: Beside;
  } | null>(null);
  const secret = useRef<HTMLInputElement>(null);
  const [tabs, setTabs] = useState<TerminalSession[]>([]);
  async function arrange(preset: Preset) {
    try {
      if (desktop) await call('broadcast_set', { ids: [] });
      setBroadcastIds([]);
      workspace.preset(preset);
      focusActiveTerminal();
    } catch (e) {
      setError(errorText(e));
    }
  }
  const [leftWidth, setLeftWidth] = useState(() =>
    Math.max(200, Math.min(420, Number(localStorage.getItem('dachsterm.leftWidth')) || 240)),
  );
  useEffect(() => {
    localStorage.setItem('dachsterm.leftWidth', String(leftWidth));
  }, [leftWidth]);
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
    beside?: Beside,
  ) {
    if (value === null && profile.hasSecret) {
      try {
        const status = await call<VaultStatus>('vault_status');
        if (status.enabled && !status.unlocked) {
          setPendingVault({ profile, existing, beside });
          setVaultOpen(true);
          return;
        }
      } catch (e) {
        setError(errorText(e));
        return;
      }
    }
    closeDrawer();
    if (existing) {
      void existing.reconnect(value, profile, remember);
      workspace.open(sessionRef(existing));
      return;
    }
    const session = new TerminalSession(profile, theme, () => {
      void refresh();
      if (profile.protocol === 'ssh') revealFiles();
    });
    setTabs((previous) => [...previous, session]);
    workspace.open(sessionRef(session), beside);
    void session.connect(value, remember);
  }
  function openLocal(target: LocalTarget, beside?: Beside) {
    const profile = { ...blankProfile(), id: target.id, name: target.name, host: 'localhost' };
    const session = new TerminalSession(profile, theme, () => {}, target);
    setTabs((previous) => [...previous, session]);
    workspace.open(sessionRef(session), beside);
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
      !document.querySelector('dialog[open]') &&
      (e.ctrlKey || e.metaKey) &&
      e.altKey &&
      !e.shiftKey &&
      e.code in focusKeys
    ) {
      e.preventDefault();
      e.stopPropagation();
      workspace.moveFocus(focusKeys[e.code]);
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
        if (workspace.groupCount > 1) workspace.toggleZoom();
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
        if (selected && capabilities(selected).terminal) selected.view.set({ search: true });
        break;
      case 'KeyO':
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
  function requestConnect(profile: Profile, existing?: TerminalSession, beside?: Beside) {
    if (existing?.podtree) {
      setPodtreeOpen(true);
      return;
    }
    if (existing?.localTarget) {
      void existing.reconnect(null, profile);
      return;
    }
    if (profile.hasSecret || ['agent', 'interactive'].includes(profile.auth))
      connect(profile, null, existing, false, beside);
    else setAuth({ profile, session: existing, beside });
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
      workspace.close(sessionKey(session));
    } catch (e) {
      setError(errorText(e));
    }
  }
  const savedProfile = (t: TerminalSession) =>
    snapshot.profiles.find((p) => p.id === t.profile.id) ?? t.profile;
  const reconnectTab = (t: TerminalSession) => requestConnect(savedProfile(t), t);
  function closeTab(session: TerminalSession) {
    session.dispose();
    const notice = tmuxCloseNotice(session.profile);
    if (notice) setError(notice);
    setTabs((previous) => previous.filter((t) => t !== session));
    workspace.close(sessionKey(session));
  }
  const closeKey = (key: string) => {
    const session = tabs.find((t) => sessionKey(t) === key);
    const game = games.find((g) => tabKey({ kind: 'game', id: g.id }) === key);
    if (session) closeTab(session);
    else if (game) closeGame(game.id);
    else workspace.close(key);
  };
  const tabMenu = useTabMenu({
    workspace,
    narrow,
    sessionOf: (key) => tabs.find((t) => sessionKey(t) === key),
    actions: {
      split: (t, beside) =>
        t.localTarget
          ? openLocal(t.localTarget, beside)
          : requestConnect(savedProfile(t), undefined, beside),
      detach: (t) => void detach(t),
      reconnect: reconnectTab,
      close: closeKey,
    },
  });
  const focusedKey = workspace.focusedGroup.active;
  const focusedTab = workspace.focusedGroup.tabs.find((tab) => tabKey(tab) === focusedKey);
  const activeGame = focusedTab?.kind === 'game' ? focusedTab.id : null;
  const hasPreview = allTabs(workspace.layout.root).some((tab) => tab.kind === 'preview');
  const selected = tabs.find((t) => sessionKey(t) === focusedKey);
  // Zoom hides groups for a moment but keeps them in the input group; a narrow window shows one.
  const inputScope = (narrow ? [workspace.focusedGroup] : groups(workspace.layout.root))
    .flatMap((group) => tabs.filter((t) => sessionKey(t) === group.active))
    .filter((t) => capabilities(t).terminal)
    .map((t) => t.connectionId)
    .sort();
  const renderTab = (tab: TabRef, group: GroupNode) => {
    const key = tabKey(tab);
    const active = group.active === key;
    const select = () => workspace.select(group.id, key);
    if (tab.kind === 'session') {
      const session = tabs.find((t) => t.tabId === tab.tabId);
      return (
        session && (
          <SessionTab
            session={session}
            active={active}
            select={select}
            close={() => closeTab(session)}
          />
        )
      );
    }
    if (tab.kind === 'preview')
      return (
        <PlainTab
          tabKey={key}
          title="터미널 미리보기"
          active={active}
          select={select}
          close={() => workspace.close(key)}
        />
      );
    return (
      <PlainTab
        tabKey={key}
        id={`game-tab-${tab.id}`}
        controls={`game-panel-${tab.id}`}
        title={games.find((game) => game.id === tab.id)?.title ?? ''}
        active={active}
        select={select}
        close={() => closeGame(tab.id)}
      />
    );
  };
  const renderCell = (tab: TabRef, { visible, focused }: CellState) => {
    if (tab.kind === 'preview')
      return (
        <div className="preview-wrap">
          <div className="preview-notice">색상과 한글 렌더링 미리보기 · SSH 연결 없음</div>
          <Suspense fallback={<p>터미널 준비 중…</p>}>
            <TerminalPreview theme={theme} />
          </Suspense>
        </div>
      );
    if (tab.kind === 'game')
      return (
        <Suspense fallback={visible ? <p>준비 중…</p> : null}>
          <GamePane
            game={tab.id}
            visible={visible}
            active={focused}
            leave={() => leaveGame(tab.id)}
            registerSurvivorClose={registerSurvivorClose}
          />
        </Suspense>
      );
    const session = tabs.find((t) => t.tabId === tab.tabId);
    if (!session) return null;
    return capabilities(session).terminal ? (
      <SessionTerminal
        session={session}
        focused={focused}
        active={visible}
        theme={theme}
        reconnect={() => reconnectTab(session)}
        close={() => closeTab(session)}
      />
    ) : (
      <FtpPane
        session={session}
        reconnect={() => reconnectTab(session)}
        close={() => closeTab(session)}
      />
    );
  };
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
      <TitleBar
        fail={setError}
        end={
          <button
            aria-label="＋ 새 연결"
            aria-haspopup="menu"
            title="새 연결 · 로컬 터미널"
            onClick={(e) => setNewMenu(anchorBelow(e.currentTarget))}
          >
            <Icon name="plus" size={16} /> <span>새 연결</span>
          </button>
        }
      >
        <ToolbarMenu label="보기">
          <button
            aria-pressed={sidebarOpen && sidebarView === 'files'}
            onClick={() => showSidebar('files')}
          >
            <Icon name="folder" size={16} /> 파일
          </button>
          <button
            onClick={() =>
              hasPreview ? workspace.close('preview') : workspace.open({ kind: 'preview' })
            }
          >
            {hasPreview ? '작업 화면' : '터미널 미리보기'}
          </button>
          {presets.map(([preset, label]) => (
            <button key={preset} onClick={() => void arrange(preset)}>
              {label}
            </button>
          ))}
          <button onClick={() => void toggleFullscreen()}>
            {fullscreen ? '전체화면 종료' : '전체화면'}
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
      </TitleBar>
      {newMenu && (
        <ContextMenu
          label="새 연결"
          at={newMenu}
          close={() => setNewMenu(null)}
          items={[
            { label: '새 연결…', shortcut: 'Ctrl/Cmd+Shift+N', run: () => setForm(blankProfile()) },
            {
              label: '로컬 터미널…',
              shortcut: 'Ctrl/Cmd+Shift+L',
              separated: true,
              run: () => setLocalOpen(true),
            },
            ...localCatalog.targets.map((target) => ({
              label: target.kind === 'wsl' ? `WSL · ${target.name}` : target.name,
              run: () => openLocal(target),
            })),
          ]}
        />
      )}
      {error && (
        <div className="app-error" role="alert">
          {error}
          <button onClick={() => setError('')} aria-label="오류 닫기">
            ×
          </button>
        </div>
      )}
      <div className="workspace-row">
        <SidebarRail
          view={sidebarView}
          open={sidebarOpen}
          choose={(view) => {
            // The press already put focus on the icon; showSidebar would move it a frame later.
            if (sidebarOpen && sidebarView === view) setSidebarOpen(false);
            else {
              setSidebarView(view);
              setSidebarOpen(true);
            }
          }}
          settings={() => setSettingsOpen('workspace')}
        />
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
                document.getElementById(`sidebar-tab-${sidebarView}`)?.focus();
              }
            }}
          >
            <aside
              id="session-sidebar"
              className="sessions"
              aria-label="세션 탐색"
              hidden={sidebarView !== 'connections'}
            >
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
                <ProfileList
                  profiles={profiles}
                  showRecent={filter === 'recent'}
                  empty={query ? '검색 결과가 없습니다.' : '등록된 서버가 없습니다.'}
                  connect={(p) => requestConnect(p)}
                  edit={setForm}
                  toggleFavorite={(p) =>
                    void action('save_session', {
                      profile: { ...p, favorite: !p.favorite },
                      secretAction: 'keep',
                      secret: null,
                    })
                  }
                  duplicate={(p) => void action('duplicate_session', { id: p.id })}
                  remove={setRemove}
                />
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
              <SidebarFiles
                session={selected}
                showConnections={() => setSidebarView('connections')}
              />
            </div>
          </div>
          {sidebarOpen && (
            <ResizeHandle
              value={leftWidth}
              min={200}
              max={420}
              onChange={setLeftWidth}
              label="사이드바 너비"
            />
          )}
          <main id="workspace" tabIndex={-1} inert={narrow && sidebarOpen && !fullscreen}>
            <WorkspaceGrid
              workspace={workspace}
              narrow={narrow}
              order={[
                ...tabs.map(sessionRef),
                ...(hasPreview ? [{ kind: 'preview' } as const] : []),
                ...gameTabs.map((id) => ({ kind: 'game', id }) as const),
              ]}
              renderTab={renderTab}
              renderCell={renderCell}
              detach={(key) => {
                const session = tabs.find((t) => sessionKey(t) === key);
                if (session && capabilities(session).detach) void detach(session);
              }}
              openMenu={tabMenu.open}
              cellClass={(tab) =>
                tabs.some(
                  (t) => sessionKey(t) === tabKey(tab) && broadcastIds.includes(t.connectionId),
                )
                  ? 'broadcast-target'
                  : ''
              }
              start={
                tabs.length || hasPreview
                  ? undefined
                  : {
                      tab: (active, select) => (
                        <PlainTab title="시작하기" active={active} select={select} />
                      ),
                      page: (
                        <Welcome
                          newConnection={() => setForm(blankProfile())}
                          openLocal={() => setLocalOpen(true)}
                          showRecent={() => {
                            setFilter('recent');
                            showSidebar('connections');
                          }}
                        />
                      ),
                    }
              }
            />
          </main>
        </div>
      </div>
      <StatusBar
        session={activeGame ? undefined : selected}
        game={games.find((game) => game.id === activeGame)?.title}
        input={
          tabs.length > 0 && (
            <span hidden={inputScope.length < 2 && !broadcastIds.length}>
              <BroadcastControl
                enabled={inputScope.length > 1}
                scope={inputScope}
                onSelectionChange={setBroadcastIds}
              />
            </span>
          )
        }
      />
      {tabMenu.element}
      {snippetsOpen && (
        <SnippetDialog
          sessions={tabs}
          active={selected?.tabId}
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
            setTabs((previous) => [...previous, session]);
            workspace.open(sessionRef(session));
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
          <ShortcutList />
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
                  void connect(
                    pendingVault.profile,
                    null,
                    pendingVault.existing,
                    false,
                    pendingVault.beside,
                  );
                }
              : undefined
          }
        />
      )}
      {settingsOpen === 'terminal' && (
        <TerminalSettings close={() => setSettingsOpen('workspace')} />
      )}
      {settingsOpen && (
        <Dialog
          title="워크스페이스 설정"
          className="settings-dialog"
          close={() => setSettingsOpen('')}
        >
          <ThemePicker />
          <section className="settings-data">
            <h3>터미널</h3>
            <div className="form-actions">
              <button onClick={() => setSettingsOpen('terminal')}>터미널 설정</button>
            </div>
            <p className="muted">
              글꼴, 스크롤 기록, 마우스와 알림 동작은 모든 터미널에 적용됩니다.
            </p>
          </section>
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
              connect(auth.profile, value, auth.session, remember, auth.beside);
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
