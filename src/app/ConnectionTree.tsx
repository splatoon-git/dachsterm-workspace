import {
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  anchorBelow,
  ContextMenu,
  isMenuKey,
  type MenuItem,
  type MenuPoint,
} from '../components/ContextMenu';
import { Icon, type IconName } from '../components/Icon';
import type { LocalCatalog, LocalTarget } from '../features/terminal/sessionTypes';
import { desktop, type Group, type Profile } from '../lib/ipc';
import { modKey } from '../lib/platform';
import { connectionSections, readFolded, writeFolded, type TreeFolder } from './connectionSections';
import './connectionTree.css';

export type TreeActions = {
  connect: (profile: Profile) => void;
  /** Asks for a folder and a preset, then starts a CLI agent in a new SSH tab. */
  startAgent: (profile: Profile) => void;
  edit: (profile: Profile) => void;
  toggleFavorite: (profile: Profile) => void;
  duplicate: (profile: Profile) => void;
  remove: (profile: Profile) => void;
  /** A new connection, saved in the group when one is given. */
  newConnection: (groupId?: string) => void;
  newGroup: (parentId?: string) => void;
  editGroup: (group: Group) => void;
  openLocal: (target: LocalTarget) => void;
  /** The dialog that lists every local shell with its description. */
  pickLocal: () => void;
  refreshLocal: () => void;
};

/** Which sections and folders are folded, remembered across starts. */
export function useFolded() {
  const [folded, setFolded] = useState(readFolded);
  const set = (key: string, fold: boolean) =>
    setFolded((previous) => {
      if (previous.has(key) === fold) return previous;
      const next = new Set(previous);
      if (fold) next.add(key);
      else next.delete(key);
      writeFolded(next);
      return next;
    });
  return {
    folded,
    toggle: (key: string) => set(key, !folded.has(key)),
    unfold: (key: string) => set(key, false),
  };
}

type Menu = { at: MenuPoint; label: string; items: MenuItem[] };

/**
 * Local terminals and saved connections in one tree of foldable sections. A connection opens on
 * double-click or Enter, a local terminal on a single click as before. Everything else is in the
 * right-click menu of the row or section, which Shift+F10, the menu key and the ⋯ button also open.
 * A search replaces the sections with one flat list of matches.
 */
export function ConnectionTree({
  profiles,
  groups,
  query,
  local,
  localLoading,
  folded,
  toggle,
  actions,
}: {
  profiles: Profile[];
  groups: Group[];
  query: string;
  local: LocalCatalog;
  localLoading: boolean;
  folded: Set<string>;
  toggle: (key: string) => void;
  actions: TreeActions;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const sections = connectionSections(profiles, groups, query);
  const term = query.trim().toLocaleLowerCase();
  const locals = local.targets.filter((t) => t.name.toLocaleLowerCase().includes(term));
  const menuHandlers = (label: string, items: () => MenuItem[]) => ({
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      setMenu({ at: { x: e.clientX, y: e.clientY }, label, items: items() });
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (!isMenuKey(e)) return false;
      e.preventDefault();
      setMenu({ at: anchorBelow(e.currentTarget), label, items: items() });
      return true;
    },
  });
  const savedItems = (): MenuItem[] => [
    { label: '새 연결…', shortcut: modKey('Shift+N'), run: () => actions.newConnection() },
    { label: '새 그룹…', run: () => actions.newGroup() },
  ];
  const profileItems = (p: Profile): MenuItem[] => [
    { label: '연결', shortcut: 'Enter', run: () => actions.connect(p) },
    ...((p.protocol ?? 'ssh') === 'ssh'
      ? [{ label: '에이전트 시작…', run: () => actions.startAgent(p) }]
      : []),
    { label: '수정…', run: () => actions.edit(p) },
    { label: p.favorite ? '즐겨찾기 해제' : '즐겨찾기', run: () => actions.toggleFavorite(p) },
    { label: '복제', run: () => actions.duplicate(p) },
    { label: '삭제…', danger: true, separated: true, run: () => actions.remove(p) },
  ];

  /**
   * One saved connection. Favorites and recent rows repeat a connection that also sits in its
   * group, so they carry their own class: `.profile-card` stays one row per connection.
   */
  const row = (p: Profile, depth: number, section: 'saved' | 'match' | 'favorite' | 'recent') => {
    const handlers = menuHandlers(`${p.name} 연결 작업`, () => profileItems(p));
    const protocol = p.protocol ?? 'ssh';
    const shortcut = section === 'favorite' || section === 'recent';
    return (
      <article
        key={`${section}-${p.id}`}
        className={shortcut ? 'profile-shortcut' : 'profile-card'}
        style={indent(depth)}
      >
        <button
          className={shortcut ? 'profile-shortcut-target' : 'profile-target'}
          onDoubleClick={() => actions.connect(p)}
          onContextMenu={handlers.onContextMenu}
          onKeyDown={(e) => {
            if (handlers.onKeyDown(e)) return;
            if (e.key === 'Enter') actions.connect(p);
          }}
          title={`${p.username}@${p.host}:${p.port}\n더블클릭 또는 Enter로 연결 · 우클릭으로 수정과 삭제`}
        >
          <Icon name="server" size={14} />
          <strong>{p.name}</strong>
          {protocol !== 'ssh' && (
            <span className={`protocol-badge ${protocol}`}>{protocol.toUpperCase()}</span>
          )}
          <span className="row-detail">
            {p.username}@{p.host}
          </span>
        </button>
      </article>
    );
  };

  const head = (
    key: string,
    title: string,
    icon: IconName,
    count: number | null,
    depth: number,
    items?: () => MenuItem[],
  ) => {
    const handlers = items ? menuHandlers(`${title} 작업`, items) : null;
    return (
      <div className="tree-head" style={indent(depth)} onContextMenu={handlers?.onContextMenu}>
        <button
          className="tree-toggle"
          aria-expanded={!folded.has(key)}
          onClick={() => toggle(key)}
          onKeyDown={(e) => handlers?.onKeyDown(e)}
        >
          <span className="tree-chevron">
            <Icon name="chevron" size={12} />
          </span>
          <Icon name={icon} size={14} />
          <span className="tree-title">{title}</span>
          {count !== null && <small className="tree-count">{count}</small>}
        </button>
        {items && (
          <button
            className="tree-more"
            aria-label={`${title} 작업`}
            onClick={(e) =>
              setMenu({ at: anchorBelow(e.currentTarget), label: `${title} 작업`, items: items() })
            }
          >
            <Icon name="more" size={14} />
          </button>
        )}
      </div>
    );
  };

  const section = (
    key: string,
    title: string,
    icon: IconName,
    count: number | null,
    children: ReactNode,
    items?: () => MenuItem[],
  ) => (
    <section className="tree-section" aria-label={title}>
      {head(key, title, icon, count, 0, items)}
      {!folded.has(key) && children}
    </section>
  );

  const folder = (f: TreeFolder, depth: number): ReactNode => (
    <div key={f.group.id} className="tree-folder" role="group" aria-label={f.group.name}>
      {head(f.group.id, f.group.name, 'folder', null, depth, () => [
        { label: '이 그룹에 새 연결…', run: () => actions.newConnection(f.group.id) },
        { label: '하위 그룹…', run: () => actions.newGroup(f.group.id) },
        { label: '그룹 수정…', separated: true, run: () => actions.editGroup(f.group) },
      ])}
      {!folded.has(f.group.id) && (
        <>
          {f.folders.map((child) => folder(child, depth + 1))}
          {f.profiles.map((p) => row(p, depth + 1, 'saved'))}
        </>
      )}
    </div>
  );

  const localRows = (
    <div className="local-targets">
      {locals.map((target) => (
        <button
          key={target.id}
          className="nav-item local-target"
          style={indent(1)}
          onClick={() => actions.openLocal(target)}
          title={`${target.name} 새 터미널 열기`}
        >
          <Icon name="terminal" size={14} />
          <span>{target.name}</span>
          {target.kind === 'wsl' && <small>WSL</small>}
        </button>
      ))}
      {localLoading && (
        <p className="tree-note" role="status">
          로컬 환경 탐색 중…
        </p>
      )}
      {!desktop && <p className="tree-note">데스크톱 앱에서 자동 탐색합니다.</p>}
      {local.warning && (
        <p className="tree-note" role="status">
          {local.warning}
        </p>
      )}
    </div>
  );

  const searching = term !== '';
  return (
    <div className="conn-tree">
      {searching ? (
        <section className="tree-section" aria-label="검색 결과">
          {locals.length > 0 && localRows}
          {sections.matches.map((p) => row(p, 1, 'match'))}
          {!locals.length && !sections.matches.length && (
            <p className="tree-empty">검색 결과가 없습니다.</p>
          )}
        </section>
      ) : (
        <>
          {sections.favorites.length > 0 &&
            section(
              'favorites',
              '즐겨찾기',
              'star',
              sections.favorites.length,
              sections.favorites.map((p) => row(p, 1, 'favorite')),
            )}
          {sections.recent.length > 0 &&
            section(
              'recent',
              '최근',
              'clock',
              null,
              sections.recent.map((p) => row(p, 1, 'recent')),
            )}
          {section('local', '로컬', 'terminal', local.targets.length, localRows, () => [
            {
              label: '로컬 터미널…',
              shortcut: modKey('Shift+L'),
              run: actions.pickLocal,
            },
            {
              label: '목록 새로고침',
              disabled: !desktop || localLoading,
              run: actions.refreshLocal,
            },
          ])}
          {section(
            'saved',
            '연결',
            'server',
            profiles.length,
            profiles.length || groups.length ? (
              <>
                {sections.folders.map((f) => folder(f, 1))}
                {sections.profiles.map((p) => row(p, 1, 'saved'))}
              </>
            ) : (
              <div className="tree-empty">
                <p>저장된 연결이 없습니다.</p>
                <button className="link-button" onClick={() => actions.newConnection()}>
                  새 연결 추가
                </button>
              </div>
            ),
            savedItems,
          )}
        </>
      )}
      {menu && (
        <ContextMenu
          label={menu.label}
          at={menu.at}
          items={menu.items}
          close={() => setMenu(null)}
        />
      )}
    </div>
  );
}
const indent = (depth: number) => ({ '--depth': depth }) as CSSProperties;
