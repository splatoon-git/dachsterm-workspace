import { useEffect, useMemo, useRef, useState } from 'react';
import { applyDrop, type DropTarget } from './workspaceDrop';
import { adjacentGroup, equalize, resize, type Divider } from './workspaceGeometry';
import {
  applyPreset,
  closeEmptyGroup,
  closeTab,
  findGroup,
  focusGroup,
  groupOfTab,
  groups,
  leaveTab,
  openTab,
  parseSaved,
  selectTab,
  serialize,
  type Layout,
  type Preset,
  type Side,
  type Size,
  type TabRef,
} from './workspaceLayout';

const STORAGE_KEY = 'dachsterm.layout';

function readSaved() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Blocked storage only costs the saved arrangement; the app starts with one group.
    return null;
  }
}

/** Workspace state. Actions are stable, so effects and listeners can hold them. */
export function useWorkspaceLayout() {
  const [layout, setLayout] = useState<Layout>(() => parseSaved(readSaved()));
  const [zoomRequested, setZoomRequested] = useState(false);
  const saved = useRef<string | null>(null);
  useEffect(() => {
    const value = serialize(layout.root);
    if (saved.current === value) return;
    saved.current = value;
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // The layout still works for this run; only the restart restore is lost.
    }
  }, [layout.root]);
  const actions = useMemo(
    () => ({
      open: (tab: TabRef) => setLayout((l) => openTab(l, tab)),
      close: (key: string) => setLayout((l) => closeTab(l, key)),
      select: (groupId: string, key: string) => setLayout((l) => selectTab(l, groupId, key)),
      focus: (groupId: string) => setLayout((l) => focusGroup(l, groupId)),
      focusTab: (key: string) =>
        setLayout((l) => {
          const group = groupOfTab(l.root, key);
          return group ? focusGroup(l, group.id) : l;
        }),
      leave: (groupId: string) => setLayout((l) => leaveTab(l, groupId)),
      leaveTab: (key: string) =>
        setLayout((l) => {
          const group = groupOfTab(l.root, key);
          return group ? leaveTab(l, group.id) : l;
        }),
      closeEmpty: (groupId: string) => setLayout((l) => closeEmptyGroup(l, groupId)),
      drop: (key: string, target: DropTarget) => {
        // A new group is out of sight while zoomed, so show the arrangement it just changed.
        if (target.zone !== 'tabbar' && target.zone !== 'center') setZoomRequested(false);
        setLayout((l) => applyDrop(l, key, target));
      },
      preset: (preset: Preset) => {
        setZoomRequested(false);
        setLayout((l) => applyPreset(l, preset));
      },
      resizeDivider: (divider: Pick<Divider, 'path' | 'index'>, px: number, canvas: Size) =>
        setLayout((l) => {
          const root = resize(l.root, divider, px, canvas);
          return root === l.root ? l : { ...l, root };
        }),
      equalizeSplit: (path: number[]) => setLayout((l) => ({ ...l, root: equalize(l.root, path) })),
      moveFocus: (direction: Side) =>
        setLayout((l) => {
          const next = adjacentGroup(l.root, l.focused, direction);
          return next ? focusGroup(l, next) : l;
        }),
      toggleZoom: () => setZoomRequested((v) => !v),
    }),
    [],
  );
  const groupCount = groups(layout.root).length;
  return {
    ...actions,
    layout,
    groupCount,
    /** Zoom only means something while another group exists to return to. */
    zoomed: zoomRequested && groupCount > 1,
    focusedGroup: findGroup(layout.root, layout.focused)!,
  };
}
export type Workspace = ReturnType<typeof useWorkspaceLayout>;
