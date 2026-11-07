import { formatBytes } from '../../lib/formatBytes';
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
} from 'react';
import { Icon, type IconName } from '../../components/Icon';
import {
  childPath,
  flattenTree,
  type FileEntry,
  type FileListView,
  type TreeRow,
} from './fileList';
import './files.css';

type Tree<T> = {
  root: string;
  expanded: ReadonlySet<string>;
  children: ReadonlyMap<string, { entries: T[]; source: object }>;
};
type Listing<T> = { path: string; entries: T[] };

/**
 * Folders open in place. Each row's name is its path relative to the listed folder, so the panels'
 * existing "listed folder + name" paths reach nested files unchanged. Children remember which root
 * listing they belong to: refreshing the root also refreshes every open folder.
 */
export function useFileTree<T extends FileEntry>(
  listing: Listing<T>,
  view: FileListView,
  list: (path: string) => Promise<{ entries: T[] }>,
) {
  const [state, setState] = useState<Tree<T>>({
    root: listing.path,
    expanded: new Set(),
    children: new Map(),
  });
  const tree = useMemo<Tree<T>>(
    () =>
      state.root === listing.path
        ? state
        : { root: listing.path, expanded: new Set(), children: new Map() },
    [listing.path, state],
  );
  useEffect(() => {
    let alive = true;
    for (const folder of tree.expanded) {
      if (tree.children.get(folder)?.source === listing) continue;
      void list(childPath(listing.path, folder)).then(
        ({ entries }) => {
          if (!alive) return;
          setState((current) => {
            if (current.root !== listing.path) return current;
            const children = new Map(current.children);
            children.set(folder, { entries, source: listing });
            return { ...current, children };
          });
        },
        () => {
          // The folder was removed or became unreadable, so it can no longer stay open.
          if (!alive) return;
          setState((current) => {
            const expanded = new Set(current.expanded);
            expanded.delete(folder);
            return { ...current, expanded };
          });
        },
      );
    }
    return () => {
      alive = false;
    };
  }, [list, listing, tree]);
  const rows = useMemo(() => {
    const entries = new Map([...tree.children].map(([k, v]) => [k, v.entries]));
    return flattenTree(listing.entries, entries, tree.expanded, view);
  }, [listing.entries, tree, view]);
  return {
    rows,
    toggle(folder: string) {
      const expanded = new Set(tree.expanded);
      if (!expanded.delete(folder)) expanded.add(folder);
      setState({ ...tree, expanded });
    },
  };
}

export type FileMenuPosition = { x: number; y: number };
export const fileMenuPosition = (event: { clientX: number; clientY: number }) => ({
  x: Math.min(event.clientX, window.innerWidth - 210),
  y: Math.min(event.clientY, window.innerHeight - 330),
});
/** Focuses the open menu and closes it on an outside press. Returns the menu's ref. */
export function useFileMenuFocus(context: FileMenuPosition | null, close: () => void) {
  const menu = useRef<HTMLDivElement>(null);
  const closeMenu = useEffectEvent(close);
  useEffect(() => {
    if (!context) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) closeMenu();
    };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [context]);
  return menu;
}

export function FileTreeRow<T extends FileEntry>({
  row,
  selected,
  toggle,
  ...button
}: {
  row: TreeRow<T>;
  selected: boolean;
  toggle: () => void;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <div className="file-tree-row" style={{ '--file-depth': row.depth } as React.CSSProperties}>
      {row.directory ? (
        <button
          type="button"
          className={`file-tree-toggle ${row.expanded ? 'open' : ''}`}
          aria-label={`${row.expanded ? '접기' : '펼치기'}: ${row.label}`}
          aria-expanded={row.expanded}
          onClick={toggle}
        >
          <Icon name="chevron" size={12} />
        </button>
      ) : (
        <span className="file-tree-toggle" />
      )}
      <button
        {...button}
        className={`file-row ${selected ? 'selected' : ''}`}
        aria-pressed={selected}
      >
        <Icon name={row.directory ? 'folder' : 'file'} size={15} />
        <span>
          {row.label}
          {row.symlink ? ' ↗' : ''}
        </span>
        {!row.directory && <small>{formatBytes(row.size)}</small>}
      </button>
    </div>
  );
}

export function FilePathBar({
  label,
  value,
  busy,
  change,
  submit,
}: {
  label: string;
  value: string;
  busy: boolean;
  change: (value: string) => void;
  submit: () => void;
}) {
  return (
    <form
      className="path-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        aria-label={label}
        title={value}
        value={value}
        onChange={(e) => change(e.target.value)}
      />
      <button aria-label="경로 이동" title="경로 이동" disabled={busy}>
        <Icon name="arrow" size={15} />
      </button>
    </form>
  );
}

export function FileAction({
  label,
  icon,
  ...button
}: { label: string; icon: IconName } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" aria-label={label} title={label} {...button}>
      <Icon name={icon} size={15} />
    </button>
  );
}

export { formatBytes };
