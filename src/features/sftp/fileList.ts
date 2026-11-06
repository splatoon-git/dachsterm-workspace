export type FileEntry = {
  name: string;
  directory: boolean;
  symlink: boolean;
  size: number | null;
  modified: number | null;
  permissions: number | null;
  /** Local files report the OS attribute. Remote files use the leading dot convention. */
  hidden?: boolean;
};
export type FileListView = { showHidden: boolean; filter: string; sort: string };
/** `name` is relative to the listed folder, and `label` is what the row displays. */
export type TreeRow<T extends FileEntry = FileEntry> = T & {
  label: string;
  depth: number;
  expanded: boolean;
};

export function visibleEntries<T extends FileEntry>(entries: T[], view: FileListView) {
  const filter = view.filter.toLocaleLowerCase();
  return entries
    .filter(
      (e) =>
        (view.showHidden || !(e.hidden ?? e.name.startsWith('.'))) &&
        e.name.toLocaleLowerCase().includes(filter),
    )
    .sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        (view.sort === 'size'
          ? (b.size ?? 0) - (a.size ?? 0)
          : view.sort === 'date'
            ? (b.modified ?? 0) - (a.modified ?? 0)
            : a.name.localeCompare(b.name)),
    );
}

/** An open folder stays listed when only something inside it matches the filter. */
export function flattenTree<T extends FileEntry>(
  entries: T[],
  children: ReadonlyMap<string, T[]>,
  expanded: ReadonlySet<string>,
  view: FileListView,
  parent = '',
  depth = 0,
): TreeRow<T>[] {
  const rows: TreeRow<T>[] = [];
  const filter = view.filter.toLocaleLowerCase();
  for (const entry of visibleEntries(entries, { ...view, filter: '' })) {
    const name = parent ? `${parent}/${entry.name}` : entry.name;
    const open = entry.directory && expanded.has(name);
    const below = open
      ? flattenTree(children.get(name) ?? [], children, expanded, view, name, depth + 1)
      : [];
    if (below.length || entry.name.toLocaleLowerCase().includes(filter))
      rows.push({ ...entry, name, label: entry.name, depth, expanded: open }, ...below);
  }
  return rows;
}

/** Selecting a folder and something inside it must act on the folder once. */
export function withoutNested(names: string[]) {
  return names.filter((name) => !names.some((other) => name.startsWith(`${other}/`)));
}

export function selectionAfterClick(
  visible: string[],
  selection: string[],
  name: string,
  anchor: string,
  event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
) {
  if (event.shiftKey && anchor) {
    const a = visible.indexOf(anchor);
    const b = visible.indexOf(name);
    return visible.slice(Math.min(a < 0 ? b : a, b), Math.max(a, b) + 1);
  }
  if (event.ctrlKey || event.metaKey)
    return selection.includes(name) ? selection.filter((n) => n !== name) : [...selection, name];
  return [name];
}

/** Local paths may be Windows paths; the backend accepts `/` after any directory form. */
export const childPath = (directory: string, name: string) =>
  `${directory.replace(/[\\/]+$/, '')}/${name}`;
