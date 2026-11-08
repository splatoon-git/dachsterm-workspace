import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { isMenuKey, type MenuPoint } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import { changeLabel, changeMark } from './gitDiff';
import type { GitActionItem } from './gitWriteMenu';
import {
  buildTree,
  flattenTree,
  splitPath,
  type GitGroup,
  type GitListItem,
  type GitRow,
} from './gitViewModel';

/** Arrow keys move between the visible rows, so a long list is one tab stop. */
export function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-git-row]')];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = rows[at + (event.key === 'ArrowDown' ? 1 : -1)];
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

/** A row's buttons, shown while the pointer is on it. The right-click menu has the same actions. */
function RowButtons({ items }: { items: GitActionItem[] }) {
  if (!items.length) return null;
  return (
    <span
      className="git-row-actions"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className="git-view-tool"
          data-danger={item.danger || undefined}
          // The row's keyboard route to these is its menu, so a long list stays one tab stop.
          tabIndex={-1}
          aria-label={item.label}
          title={item.label}
          disabled={item.disabled}
          onClick={item.run}
        >
          <Icon name={item.icon} size={14} />
        </button>
      ))}
    </span>
  );
}

function FileRow({
  row,
  depth,
  showFolder,
  first,
  open,
  menu,
  buttons,
}: {
  row: GitRow;
  depth: number;
  showFolder: boolean;
  first: boolean;
  open: (row: GitRow, pinned: boolean) => void;
  menu: (row: GitRow, at: MenuPoint | HTMLElement) => void;
  buttons: GitActionItem[];
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
      onClick={() => open(row, false)}
      onDoubleClick={() => open(row, true)}
      onContextMenu={(event: MouseEvent) => {
        event.preventDefault();
        menu(row, { x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          open(row, false);
          return;
        }
        if (!isMenuKey(event)) return;
        event.preventDefault();
        menu(row, event.currentTarget);
      }}
    >
      <span className="git-row-name">{name}</span>
      {showFolder && folder && <span className="git-row-folder">{folder}</span>}
      <RowButtons items={buttons} />
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
  open,
  menu,
  groupMenu,
  rowButtons,
  groupButtons,
}: {
  group: GitGroup;
  tree: boolean;
  first: boolean;
  folded: ReadonlySet<string>;
  toggle: (key: string) => void;
  open: (row: GitRow, pinned: boolean) => void;
  menu: (row: GitRow, at: MenuPoint | HTMLElement) => void;
  groupMenu: (group: GitGroup, at: MenuPoint | HTMLElement) => void;
  rowButtons: (row: GitRow) => GitActionItem[];
  groupButtons: (group: GitGroup) => GitActionItem[];
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
      <div className="git-group-bar">
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
        <RowButtons items={groupButtons(group)} />
      </div>
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
                open={open}
                menu={menu}
                buttons={rowButtons(item.row)}
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
  open,
  menu,
  groupMenu,
  rowButtons,
  groupButtons,
}: {
  groups: GitGroup[];
  tree: boolean;
  open: (row: GitRow, pinned: boolean) => void;
  menu: (row: GitRow, at: MenuPoint | HTMLElement) => void;
  groupMenu: (group: GitGroup, at: MenuPoint | HTMLElement) => void;
  rowButtons: (row: GitRow) => GitActionItem[];
  groupButtons: (group: GitGroup) => GitActionItem[];
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
          open={open}
          menu={menu}
          groupMenu={groupMenu}
          rowButtons={rowButtons}
          groupButtons={groupButtons}
        />
      ))}
    </div>
  );
}
