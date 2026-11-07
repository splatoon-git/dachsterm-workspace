import { Icon, type IconName } from '../components/Icon';
import { ToolbarMenu } from '../components/ToolbarMenu';
import { games, type GameId } from '../features/games/catalog';
import { desktop } from '../lib/ipc';
import { modKey } from '../lib/platform';

function IconButton({
  icon,
  label,
  keys,
  run,
  pressed,
  controls,
}: {
  icon: IconName;
  label: string;
  /** The shortcut after Ctrl or Command, shown in the tooltip. */
  keys: string;
  run: () => void;
  pressed?: boolean;
  controls?: string;
}) {
  return (
    <button
      className="header-icon"
      aria-label={label}
      title={`${label} · ${modKey(keys)}`}
      aria-expanded={pressed}
      aria-controls={controls}
      onClick={run}
    >
      <Icon name={icon} size={16} />
    </button>
  );
}

/** Left of the title bar: the sidebar toggle and the tools menu, which holds the games for now. */
export function HeaderMenus({
  sidebarOpen,
  toggleSidebar,
  activeGame,
  openGame,
  preview,
}: {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  activeGame: GameId | null;
  openGame: (id: GameId) => void;
  /** Opens the terminal preview, which only the browser run without a backend offers. */
  preview: () => void;
}) {
  return (
    <>
      <IconButton
        icon="sidebar"
        label="사이드바"
        keys="Shift+B"
        pressed={sidebarOpen}
        controls="workspace-sidebar"
        run={toggleSidebar}
      />
      <ToolbarMenu label="도구">
        <span className="menu-label">게임</span>
        <nav aria-label="게임 목록">
          {games.map((game) => (
            <button
              key={game.id}
              aria-current={activeGame === game.id ? 'page' : undefined}
              onClick={() => openGame(game.id)}
            >
              <Icon name="game" size={14} />
              {game.title}
            </button>
          ))}
        </nav>
        {!desktop && (
          <>
            <span className="menu-label">개발 실행</span>
            <button onClick={preview}>터미널 미리보기</button>
          </>
        )}
      </ToolbarMenu>
    </>
  );
}

/** Right of the title bar: what used to sit in the view and tools menus, one icon each. */
export function HeaderActions({
  commands,
  tunnels,
  help,
  settings,
}: {
  commands: () => void;
  tunnels: () => void;
  help: () => void;
  settings: () => void;
}) {
  return (
    <>
      <IconButton icon="snippet" label="명령" keys="Shift+S" run={commands} />
      <IconButton icon="tunnel" label="터널" keys="Shift+U" run={tunnels} />
      <span className="header-divider" aria-hidden="true" />
      <IconButton icon="keyboard" label="키보드 단축키" keys="Shift+/" run={help} />
      <IconButton icon="settings" label="설정" keys="," run={settings} />
    </>
  );
}
