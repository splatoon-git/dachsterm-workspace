import {
  groupOfTab,
  groups,
  openBeside,
  replaceGroup,
  tabKey,
  withActive,
  type GroupNode,
  type Layout,
  type MakeId,
  type TabRef,
} from './workspaceLayout';

/**
 * Tab operations for documents: a tab opened by a single click is a preview, which the next click
 * replaces, until something pins it. The flag travels on the tab, so moving a tab between groups
 * needs no extra handling. (`{ kind: 'preview' }` is the unrelated terminal colour preview.)
 *
 * GE.8's diff tabs join by adding their kind to `DocumentRef`.
 */
export type DocumentRef = Extract<TabRef, { kind: 'file' }>;

export type DocumentPlacement = {
  /** Key of a tab that must stay on screen, such as the FTP list the file was clicked in. */
  keepVisible?: string;
  makeId?: MakeId;
};

const isPreview = (tab: TabRef) => tab.kind === 'file' && !!tab.preview;
const pinned = (tab: TabRef): TabRef =>
  tab.kind === 'file' && tab.preview ? { ...tab, preview: false } : tab;

/** The group a new document goes to, or null when only a new group would keep `keepVisible` shown. */
function documentGroup(layout: Layout, keepVisible?: string): GroupNode | null {
  const kept = keepVisible ? groupOfTab(layout.root, keepVisible) : undefined;
  const usable = groups(layout.root).filter((group) => group.id !== kept?.id);
  return (
    usable.find((group) => !group.tabs.length) ??
    usable.find((group) => group.id === layout.focused) ??
    usable.find((group) => group.tabs.some(isPreview)) ??
    usable[0] ??
    null
  );
}

function lastPreview(group: GroupNode) {
  return group.tabs.filter(isPreview).at(-1);
}

/**
 * The tab `openDocument` would replace, so its owner can forget what the tab held. A pinned
 * document replaces nothing, and neither does a file that already has a tab.
 */
export function replacedPreview(
  layout: Layout,
  tab: DocumentRef,
  placement: DocumentPlacement = {},
): string | undefined {
  if (!tab.preview || groupOfTab(layout.root, tabKey(tab))) return undefined;
  const target = documentGroup(layout, placement.keepVisible);
  const old = target && lastPreview(target);
  return old ? tabKey(old) : undefined;
}

/** Puts `tab` where the group's preview was, or last. Any other preview there becomes pinned. */
function placed(group: GroupNode, tab: DocumentRef): GroupNode {
  const key = tabKey(tab);
  const old = tab.preview ? lastPreview(group) : undefined;
  if (!old) return { ...withActive(group, key), tabs: [...group.tabs, tab] };
  const oldKey = tabKey(old);
  const tabs = group.tabs.map((item) => (item === old ? tab : pinned(item)));
  // A replaced tab no longer exists, so it cannot be what the group returns to.
  return group.active === oldKey
    ? { ...group, tabs, active: key }
    : { ...withActive(group, key), tabs };
}

/** Opens a document, or selects the one already open. Never closes anything but a preview. */
export function openDocument(
  layout: Layout,
  tab: DocumentRef,
  placement: DocumentPlacement = {},
): Layout {
  const key = tabKey(tab);
  const existing = groupOfTab(layout.root, key);
  if (existing) {
    const active = withActive(existing, key);
    return active === existing && layout.focused === existing.id
      ? layout
      : { root: replaceGroup(layout.root, existing.id, () => active), focused: existing.id };
  }
  const target = documentGroup(layout, placement.keepVisible);
  if (!target) {
    const beside = groupOfTab(layout.root, placement.keepVisible!)!;
    return openBeside(layout, tab, beside.id, 'right', placement.makeId);
  }
  return {
    root: replaceGroup(layout.root, target.id, (group) => placed(group, tab)),
    focused: target.id,
  };
}

/** Keeps a preview open: the next single click opens beside it. */
export function pinDocument(layout: Layout, key: string): Layout {
  const group = groupOfTab(layout.root, key);
  const tab = group?.tabs.find((item) => tabKey(item) === key);
  if (!group || !tab || !isPreview(tab)) return layout;
  return {
    ...layout,
    root: replaceGroup(layout.root, group.id, (g) => ({
      ...g,
      tabs: g.tabs.map((item) => (item === tab ? pinned(item) : item)),
    })),
  };
}
