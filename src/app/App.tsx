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
import { useAgentLaunch, type Opening } from './useAgentLaunch';
import { useAppShortcuts, type AppShortcut } from './appShortcuts';
import { useWindowClose } from './useWindowClose';
import { useAgentBoard } from './useAgentBoard';
import { useNarrowViewport } from './useNarrowViewport';
import { SettingsDialog } from './SettingsDialog';
import { StatusBar } from './StatusBar';
import {
  allTabs,
  displayRoot,
  groups,
  tabKey,
  type GroupNode,
  type TabRef,
} from './workspaceLayout';
import { InputScopeControl, InputScopeMark } from '../features/terminal/InputScope';
import { useInputScope } from '../features/terminal/useInputScope';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from '../themes/useTheme';
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
import { TerminalSession, type LocalCatalog, type LocalTarget } from '../features/terminal/session';
import { CommandPanel } from '../features/terminal/CommandPanel';
import { SessionPane } from './SessionPane';
import { useInputPanes } from './inputPanes';
import { GroupDialog } from './GroupDialog';
import { useChatTabs } from './useChatTabs';
import { useReviewTabs } from './useReviewTabs';
import { useFileTabs } from './useFileTabs';
import { useToolTabs } from './useToolTabs';
import { useKubeTabs } from './useKubeTabs';
import { useVaultGate } from './useVaultGate';
import { tmuxCloseNotice } from './tmuxNotice';
import { TunnelPanel } from '../features/tunnels/TunnelPanel';
import { ResizeHandle } from '../components/ResizeHandle';
import { SessionTab } from './SessionTab';
import { capabilities } from '../features/terminal/sessionKind';
import { SidebarViews } from './SidebarViews';
import { PreviewTab, TerminalPreviewCell } from './TerminalPreviewCell';
import { Icon } from '../components/Icon';
import { Dialog } from '../components/Dialog';
import { TitleBar } from './TitleBar';
import { SidebarTabs, type SidebarView } from './SidebarTabs';
import { ConnectionTree, useFolded } from './ConnectionTree';
import { localClusterOf, localTabProfile, type LocalClusterProfile } from './connectionSections';
import { HeaderActions, HeaderMenus } from './HeaderTools';
import { modKey } from '../lib/platform';
import { saveSetting } from '../lib/saveSetting';
const GamePane = lazy(() => import('../features/games/GamePane'));
import { games, type GameId } from '../features/games/catalog';
const sessionRef = (session: TerminalSession): TabRef => ({
  kind: 'session',
  tabId: session.tabId,
});
const sessionKey = (session: TerminalSession) => tabKey(sessionRef(session));
export function App() {
  const theme = useTheme();
  const narrow = useNarrowViewport();
  const [snapshot, setSnapshot] = useState<Snapshot>({ profiles: [], groups: [] });
  const [localCatalog, setLocalCatalog] = useState<LocalCatalog>({ targets: [], warning: null });
  const [localLoading, setLocalLoading] = useState(desktop);
  const [localOpen, setLocalOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const tree = useFolded();
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.innerWidth > 700 && localStorage.getItem('dachsterm.sidebar') !== 'false',
  );
  // No tab survives a restart, so the file view would open empty.
  const [sidebarView, setSidebarView] = useState<SidebarView>('connections');
  const closeDrawer = () => window.innerWidth <= 700 && setSidebarOpen(false);
  // A new SSH connection shows its files, but a drawer must not cover a narrow window's terminal.
  const revealFiles = () => {
    setSidebarView('files');
    if (window.innerWidth > 700) setSidebarOpen(true);
  };
  const showSidebar = async (view: SidebarView, focusSearch = false) => {
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
  useEffect(() => saveSetting('dachsterm.sidebar', String(sidebarOpen)), [sidebarOpen]);
  const workspace = useWorkspaceLayout();
  const { open: openWorkspaceTab } = workspace;
  const [tunnelsOpen, setTunnelsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const vault = useVaultGate(setError);
  const [form, setForm] = useState<Profile | null>(null);
  const [group, setGroup] = useState<Group | null>(null);
  const [remove, setRemove] = useState<Profile | null>(null);
  const [auth, setAuth] = useState<{
    profile: Profile;
    session?: TerminalSession;
    opening?: Opening;
  } | null>(null);
  const secret = useRef<HTMLInputElement>(null);
  const [tabs, setTabs] = useState<TerminalSession[]>([]);
  const [leftWidth, setLeftWidth] = useState(() =>
    Math.max(200, Math.min(420, Number(localStorage.getItem('dachsterm.leftWidth')) || 240)),
  );
  useEffect(() => saveSetting('dachsterm.leftWidth', String(leftWidth)), [leftWidth]);
  const [query, setQuery] = useState('');
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
    opening: Opening = {},
  ) {
    const retry = () => void connect(profile, null, existing, false, opening);
    if (value === null && profile.hasSecret && !(await vault.ready(retry))) return;
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
    workspace.open(sessionRef(session), opening.beside);
    agent.connect(session, value, remember, opening.launch);
  }
  const agent = useAgentLaunch((p, launch) => requestConnect(p, undefined, { launch }));
  function openLocal(target: LocalTarget, beside?: Beside, cluster?: LocalClusterProfile) {
    const session = new TerminalSession(localTabProfile(target, cluster), theme, () => {}, target);
    setTabs((previous) => [...previous, session]);
    workspace.open(sessionRef(session), beside);
    setLocalOpen(false);
    closeDrawer();
    void session.connect(null);
  }
  const keptByFile = (shortcut: AppShortcut) => files.keepsShortcut(shortcut);
  const runShortcut = (shortcut: AppShortcut) => {
    if (shortcut.name === 'chat') return chats.toggleLauncher();
    switch (shortcut.name) {
      case 'fullscreen':
        return void toggleFullscreen();
      case 'moveFocus':
        return workspace.moveFocus(shortcut.side);
      case 'zoom':
        return workspace.groupCount > 1 && workspace.toggleZoom();
      case 'local':
        return setLocalOpen(true);
      case 'newConnection':
        return setForm(blankProfile());
      case 'sidebar':
        return fullscreen ? void showSidebar(sidebarView) : setSidebarOpen((v) => !v);
      case 'terminalSearch':
        return selected && capabilities(selected).terminal && selected.view.set({ search: true });
      case 'sessionSearch':
        return void showSidebar('connections', true);
      case 'files':
        return void showSidebar('files');
      case 'inputScope':
        return input.shortcut();
      case 'review':
        return selected && reviews.open(selected);
      case 'splitRight':
        // Like the tab menu: the same target again, as a new connection and a new shell.
        if (selected && capabilities(selected).split && !narrow)
          splitTab(selected, { groupId: workspace.focusedGroup.id, side: 'right' });
        return;
      case 'commands':
        return setCommandsOpen(true);
      case 'tunnels':
        return setTunnelsOpen(true);
      case 'help':
        return setHelpOpen(true);
      case 'nextAgent':
        return agents.next();
      case 'settings':
        return setSettingsOpen(true);
    }
  };
  useAppShortcuts(keptByFile, runShortcut, () => tabMenu.closeFocused());
  function requestConnect(profile: Profile, existing?: TerminalSession, opening?: Opening) {
    if (existing?.podTerminal) {
      void kubeTabs.reconnect(existing);
      return;
    }
    if (existing?.localTarget) {
      void existing.reconnect(null, profile);
      return;
    }
    if (profile.hasSecret || ['agent', 'interactive'].includes(profile.auth))
      connect(profile, null, existing, false, opening);
    else setAuth({ profile, session: existing, opening });
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
    else if (![reviews, files, tools, chats].some((t) => t.close(key))) workspace.close(key);
  };
  const splitTab = (t: TerminalSession, beside: Beside) =>
    t.localTarget
      ? openLocal(t.localTarget, beside, localClusterOf(t.profile))
      : requestConnect(savedProfile(t), undefined, { beside });
  const kubeTabs = useKubeTabs({ workspace, theme, tabs, setTabs, closeTab });
  const reviews = useReviewTabs({ workspace, sessions: tabs, narrow });
  const chats = useChatTabs({ workspace, sessions: tabs, profiles: snapshot.profiles });
  const files = useFileTabs({ workspace, sessions: tabs, narrow, fail: setError });
  const tools = useToolTabs({
    workspace,
    profiles: snapshot.profiles,
    sessions: tabs,
    vaultReady: vault.ready,
  });
  useWindowClose({
    confirm: async () => settleSurvivorBeforeClose() && files.confirmWindowClose(),
    blocked: () => !settleSurvivorBeforeClose() || files.hasUnsaved(),
    fail: setError,
  });
  const tabMenu = useTabMenu({
    workspace,
    narrow,
    sessionOf: (key) => tabs.find((t) => sessionKey(t) === key),
    actions: {
      split: splitTab,
      detach: (t) => void detach(t),
      review: (t) => reviews.open(t),
      reconnect: reconnectTab,
      close: closeKey,
      files,
      chat: chats.menu,
      arranged: focusActiveTerminal,
    },
  });
  const focusedKey = workspace.focusedGroup.active;
  const focusedTab = workspace.focusedGroup.tabs.find((tab) => tabKey(tab) === focusedKey);
  const activeGame = focusedTab?.kind === 'game' ? focusedTab.id : null;
  const hasPreview = allTabs(workspace.layout.root).some((tab) => tab.kind === 'preview');
  const selected = tabs.find((t) => sessionKey(t) === focusedKey);
  const owner = selected ?? files.owner(focusedKey);
  const agents = useAgentBoard({ tabs, chats, selected, open: workspace.open, fail: setError });
  const activeSession = (group: GroupNode) => tabs.find((t) => sessionKey(t) === group.active);
  // Only panes on screen take part: zoom and a narrow window leave one group in view.
  const input = useInputScope(
    useInputPanes(
      groups(displayRoot(workspace.layout, { zoomed: workspace.zoomed, narrow })),
      activeSession,
    ),
  );
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
    if (tab.kind === 'review') return reviews.renderTab(tab, active, select);
    if (tab.kind === 'tool') return tools.renderTab(tab, active, select);
    if (tab.kind === 'file' || tab.kind === 'diff') return files.renderTab(tab, active, select);
    if (tab.kind === 'chat') return chats.renderTab(tab, active, select);
    if (tab.kind === 'preview')
      return <PreviewTab tabKey={key} active={active} select={select} close={workspace.close} />;
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
    if (tab.kind === 'review') return reviews.renderCell(tab);
    if (tab.kind === 'chat') return chats.renderCell(tab);
    if (tab.kind === 'tool') return tools.renderCell(tab, visible);
    if (tab.kind === 'file' || tab.kind === 'diff') return files.renderCell(tab);
    if (tab.kind === 'preview') return <TerminalPreviewCell theme={theme} />;
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
    return (
      <SessionPane
        session={session}
        focused={focused}
        active={visible}
        theme={theme}
        open={(path, pinned) => files.open(session, path, pinned)}
        reconnect={() => reconnectTab(session)}
        close={() => closeTab(session)}
        openPodTerminal={(request) => kubeTabs.open(session, request)}
      />
    );
  };
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
      <TitleBar fail={setError} end={<HeaderActions run={runShortcut} chat={chats.launcher} />}>
        <HeaderMenus
          sidebarOpen={sidebarOpen}
          toggleSidebar={() =>
            fullscreen ? void showSidebar(sidebarView) : setSidebarOpen((v) => !v)
          }
          tools={{
            tunnels: () => runShortcut({ name: 'tunnels' }),
            editor: files.pickDocument,
            network: tools.open,
          }}
          activeTool={focusedTab?.kind === 'tool' ? focusedTab.id : null}
          activeGame={activeGame}
          openGame={openGame}
          preview={() => workspace.open({ kind: 'preview' })}
        />
      </TitleBar>
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
          } as React.CSSProperties
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
              document.querySelector<HTMLElement>('[aria-controls="workspace-sidebar"]')?.focus();
            }
          }}
        >
          <SidebarTabs view={sidebarView} choose={setSidebarView} />
          <aside
            id="session-sidebar"
            className="sessions connections-view"
            aria-label="세션 탐색"
            hidden={sidebarView !== 'connections'}
          >
            <div className="sidebar-search">
              <input
                ref={searchInput}
                type="search"
                aria-label="세션 검색"
                placeholder={`연결 검색 · ${modKey('Shift+O')}`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="connections-scroll">
              <ConnectionTree
                profiles={snapshot.profiles}
                groups={snapshot.groups}
                query={query}
                local={localCatalog}
                localLoading={localLoading}
                folded={tree.folded}
                toggle={tree.toggle}
                actions={{
                  connect: (p) => requestConnect(p),
                  startAgent: (p) => agent.ask(p),
                  chats: chats.tree,
                  edit: setForm,
                  toggleFavorite: (p) =>
                    void action('save_session', {
                      profile: { ...p, favorite: !p.favorite },
                      secretAction: 'keep',
                      secret: null,
                    }),
                  duplicate: (p) => void action('duplicate_session', { id: p.id }),
                  remove: setRemove,
                  newConnection: (groupId) =>
                    setForm({ ...blankProfile(), groupId: groupId ?? null }),
                  newGroup: (parentId) => setGroup({ id: '', name: '', parentId }),
                  editGroup: setGroup,
                  openLocal: (target, cluster) => openLocal(target, undefined, cluster),
                  pickLocal: () => setLocalOpen(true),
                  refreshLocal: () => void refreshLocal(),
                }}
              />
            </div>
          </aside>
          <SidebarViews
            view={sidebarView}
            session={owner}
            showConnections={() => setSidebarView('connections')}
            startAgent={(folder) => owner && agent.ask(savedProfile(owner), folder)}
            openChat={(folder) => owner && chats.openFrom(owner, folder)}
            openReview={() => owner && reviews.open(owner)}
            files={files}
          />
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
              ...reviews.order,
              ...chats.order,
              ...files.order,
              ...tools.order,
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
                (t) =>
                  sessionKey(t) === tabKey(tab) && input.status.selected.includes(t.connectionId),
              )
                ? 'broadcast-target'
                : ''
            }
            groupMark={(group) => (
              <InputScopeMark
                input={input}
                connectionId={activeSession(group)?.connectionId}
                name={activeSession(group)?.profile.name ?? ''}
              />
            )}
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
                          tree.unfold('recent');
                          void showSidebar('connections');
                        }}
                      />
                    ),
                  }
            }
          />
        </main>
      </div>
      <StatusBar
        session={activeGame ? undefined : owner}
        file={files.status(focusedTab)}
        game={games.find((game) => game.id === activeGame)?.title}
        sending={input.sending}
        input={tabs.length > 0 && <InputScopeControl input={input} />}
        agents={agents}
        showGit={() => void showSidebar('git')}
      />
      {tabMenu.element}
      {files.dialog}
      {commandsOpen && (
        <CommandPanel
          sessions={tabs}
          active={selected?.tabId}
          close={() => setCommandsOpen(false)}
        />
      )}
      {localOpen && (
        <Dialog
          title="로컬 터미널 열기"
          description="서버 등록 없이 이 컴퓨터에서 셸을 엽니다. WSL은 배포판의 기본 사용자로 열립니다."
          size="small"
          close={() => setLocalOpen(false)}
        >
          {localLoading && <p role="status">이 컴퓨터의 셸을 찾는 중…</p>}
          {!desktop && (
            <p className="dialog-empty">
              데스크톱 앱에서 PowerShell·WSL 또는 macOS 기본 셸을 자동으로 찾습니다.
            </p>
          )}
          <div className="local-picker">
            {localCatalog.targets.map((target) => (
              <button key={target.id} onClick={() => openLocal(target)}>
                <Icon name="terminal" size={16} />
                <strong>{target.name}</strong>
                <span>{target.kind === 'wsl' ? 'WSL 배포판' : '로컬 셸'}</span>
              </button>
            ))}
          </div>
          {localCatalog.warning && <p role="alert">{localCatalog.warning}</p>}
          {!localLoading && desktop && !localCatalog.targets.length && (
            <p className="dialog-empty">찾은 셸이 없습니다. 설치 상태를 확인하고 새로고침하세요.</p>
          )}
          <div className="form-actions">
            <button
              className="start"
              disabled={!desktop || localLoading}
              onClick={() => void refreshLocal()}
            >
              <Icon name="refresh" size={14} />
              목록 새로고침
            </button>
            <button onClick={() => setLocalOpen(false)}>닫기</button>
          </div>
        </Dialog>
      )}
      {helpOpen && (
        <Dialog
          title="키보드 단축키"
          description="대화상자가 열려 있을 때는 앱 단축키가 동작하지 않습니다."
          size="small"
          close={() => setHelpOpen(false)}
        >
          <ShortcutList />
        </Dialog>
      )}
      {tunnelsOpen && (
        <TunnelPanel
          session={selected?.podTerminal || selected?.localTarget ? undefined : selected}
          sessions={tabs}
          profiles={snapshot.profiles}
          close={() => setTunnelsOpen(false)}
        />
      )}
      {vault.dialog}
      {agent.dialogs}
      {chats.dialog}
      <SettingsDialog
        open={settingsOpen}
        setOpen={setSettingsOpen}
        snapshot={snapshot}
        session={selected}
        changed={() => void refresh()}
      />
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
        <Dialog
          title={`${auth.profile.name} 인증`}
          description={`${auth.profile.username}@${auth.profile.host}:${auth.profile.port}`}
          size="small"
          close={() => setAuth(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const value = secret.current?.value ?? '';
              if (secret.current) secret.current.value = '';
              const remember = new FormData(e.currentTarget).get('rememberSecret') === 'on';
              connect(auth.profile, value, auth.session, remember, auth.opening);
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
            <p className="field-help">
              저장하면 보안 저장소에 두고 다음 접속에 씁니다. OTP와 추가 인증 응답은 저장하지
              않습니다.
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
        <GroupDialog group={group} setGroup={setGroup} snapshot={snapshot} action={action} />
      )}
      {remove && (
        <Dialog title="세션 삭제" size="small" close={() => setRemove(null)}>
          <p>
            <strong>{remove.name}</strong> 세션과 보안 저장소의 인증정보를 지웁니다. 열린 연결은
            유지됩니다. 지우기 전에 복구본을 만들어 두며, 설정 › 복구·진단에서 다시 추가할 수
            있습니다.
          </p>
          <div className="form-actions">
            <button onClick={() => setRemove(null)}>취소</button>
            <button
              className="danger"
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
