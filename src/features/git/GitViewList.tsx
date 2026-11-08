import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { isMenuKey, type MenuPoint } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import { changeLabel, changeMark } from './gitDiff';
import {
  buildTree,
  flattenTree,
  splitPath,
  type GitGroup,
  type GitListItem,
  type GitRow,
} from './gitViewModel';

/** Arrow keys move between the visible rows, so a long list is one tab stop. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-git-row]')];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = rows[at + (event.key === 'ArrowDown' ? 1 : -1)];
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

function FileRow({
  row,
  depth,
  showFolder,
  first,
  menu,
}: {
  row: GitRow;
  depth: number;
  showFolder: boolean;
  first: boolean;
  menu: (row: GitRow, at: MenuPoint | HTMLElement) => void;
}) {
  const { name, folder } = splitPath(row.path);
  const title = `${row.oldPath ? `${row.oldPath} → ` : ''}${row.path} · ${changeLabel[row.change]}${
    row.readable ? '' : ' · 파일 이름을 UTF-8로 읽을 수 없음'
  }`;
  return (
    <li
      className="git-row"
      data-git-row=""
      style={{ '--git-depth': depth } as React.CSSProperties}
      title={title}
      tabIndex={first ? 0 : -1}
      onContextMenu={(event: MouseEvent) => {
        event.preventDefault();
        menu(row, { x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (!isMenuKey(event)) return;
        event.preventDefault();
        menu(row, event.currentTarget);
      }}
    >
      <span className="git-row-name">{name}</span>
      {showFolder && folder && <span className="git-row-folder">{folder}</span>}
      <span className="git-row-mark" data-change={row.change} aria-label={changeLabel[row.change]}>
        {changeMark[row.change]}
      </span>
    </li>
  );
}

function FolderRow({
  item,
  toggle,
}: {
  item: Extract<GitListItem, { kind: 'folder' }>;
  toggle: (key: string) => void;
}) {
  return (
    <li
      className="git-row git-row-folder-row"
      data-git-row=""
      style={{ '--git-depth': item.depth } as React.CSSProperties}
      role="button"
      tabIndex={-1}
      aria-expanded={!item.folded}
      onClick={() => toggle(item.key)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle(item.key);
      }}
    >
      <span className="git-row-chevron" data-folded={item.folded || undefined}>
        <Icon name="chevron" size={12} />
      </span>
      <span className="git-row-name">{item.name}</span>
    </li>
  );
}

function Group({
  group,
  tree,
  first,
  folded,
  toggle,
  menu,
  groupMenu,
}: {
  group: GitGroup;
  tree: boolean;
  first: boolean;
  folded: ReadonlySet<string>;
  toggle: (key: string) => void;
  menu: (row: GitRow, at: MenuPoint | HTMLElement) => void;
  groupMenu: (group: GitGroup, at: MenuPoint | HTMLElement) => void;
}) {
  const closed = folded.has(group.id);
  const items = useMemo<GitListItem[]>(
    () =>
      tree
        ? flattenTree(buildTree(group.rows), folded, group.id)
        : group.rows.map((row) => ({ kind: 'file', row, depth: 0 })),
    [folded, group, tree],
  );
  return (
    <section aria-label={group.label}>
      <button
        type="button"
        className="git-group-head"
        aria-expanded={!closed}
        onClick={() => toggle(group.id)}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          groupMenu(group, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (!isMenuKey(event)) return;
          event.preventDefault();
          groupMenu(group, event.currentTarget);
        }}
      >
        <span className="git-row-chevron" data-folded={closed || undefined}>
          <Icon name="chevron" size={12} />
        </span>
        <span>{group.label}</span>
        <small>{group.rows.length}</small>
      </button>
      {!closed && (
        <ul className="git-list">
          {items.map((item, index) =>
            item.kind === 'file' ? (
              <FileRow
                key={item.row.key}
                row={item.row}
                depth={item.depth}
                showFolder={!tree}
                first={first && index === 0}
                menu={menu}
              />
            ) : (
              <FolderRow key={item.key} item={item} toggle={toggle} />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

/** The changed files by group, as a flat list or as folders. */
export function GitViewList({
  groups,
  tree,
  menu,
  groupMenu,
}: {
  groups: GitGroup[];
  tree: boolean;
  menu: (row: GitRow, at: MenuPoint | HTMLElement) => void;
  groupMenu: (group: GitGroup, at: MenuPoint | HTMLElement) => void;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setFolded((old) => {
      const next = new Set(old);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <div className="git-groups" onKeyDown={moveFocus}>
      {groups.map((group, index) => (
        <Group
          key={group.id}
          group={group}
          tree={tree}
          first={index === 0}
          folded={folded}
          toggle={toggle}
          menu={menu}
          groupMenu={groupMenu}
        />
      ))}
    </div>
  );
}
