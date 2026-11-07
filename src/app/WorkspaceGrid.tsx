import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { ResizeHandle } from '../components/ResizeHandle';
import { GroupTabBar } from './GroupTabBar';
import { useTabDrag } from './useTabDrag';
import type { Workspace } from './useWorkspaceLayout';
import { dropPreviewRect } from './workspaceDrop';
import { dividerRange, dividers, rects, type Rect } from './workspaceGeometry';
import {
  displayRoot,
  groupOfTab,
  groups,
  tabKey,
  TAB_BAR_HEIGHT,
  type GroupNode,
  type Size,
  type TabRef,
} from './workspaceLayout';
import './workspaceGrid.css';

export type CellState = {
  /** The cell is on screen. */
  visible: boolean;
  /** The cell is on screen in the focused group, so the keyboard belongs to it. */
  focused: boolean;
};

const GAP = 1.5;
const EDGE = 1e-6;

/** Half of the old 3px grid gap on each inner edge, so the background reads as the border. */
function insets(rect: Rect) {
  return {
    left: rect.x > EDGE ? GAP : 0,
    right: rect.x + rect.w < 1 - EDGE ? GAP : 0,
    top: rect.y > EDGE ? GAP : 0,
    bottom: rect.y + rect.h < 1 - EDGE ? GAP : 0,
  };
}
function barStyle(rect: Rect): CSSProperties {
  const gap = insets(rect);
  return {
    left: `calc(${rect.x * 100}% + ${gap.left}px)`,
    top: `calc(${rect.y * 100}% + ${gap.top}px)`,
    width: `calc(${rect.w * 100}% - ${gap.left + gap.right}px)`,
    height: TAB_BAR_HEIGHT,
  };
}
function bodyStyle(rect: Rect): CSSProperties {
  const gap = insets(rect);
  return {
    left: `calc(${rect.x * 100}% + ${gap.left}px)`,
    top: `calc(${rect.y * 100}% + ${gap.top + TAB_BAR_HEIGHT}px)`,
    width: `calc(${rect.w * 100}% - ${gap.left + gap.right}px)`,
    height: `calc(${rect.h * 100}% - ${gap.top + gap.bottom + TAB_BAR_HEIGHT}px)`,
  };
}

function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** Puts the keyboard back in the focused group's terminal, for controls outside the terminal. */
export function focusActiveTerminal() {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('.pane-cell.focused .xterm-helper-textarea')?.focus();
  });
}
/** Moves focus to the focused group's selected tab, where keyboard navigation continues. */
export function focusSelectedTab() {
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>('.tab-strip[data-focused-group="true"] [aria-selected="true"]')
      ?.focus();
  });
}

/**
 * Lays out every tab as a flat list of absolutely placed cells. A tab moving between groups only
 * changes its coordinates, so React keeps its terminal, scrollback and local state.
 */
export function WorkspaceGrid({
  workspace,
  narrow,
  order,
  renderTab,
  renderCell,
  cellClass,
  start,
  detach,
}: {
  workspace: Workspace;
  narrow: boolean;
  /** Tabs in the order they were opened. It never changes for an open tab, so nodes stay put. */
  order: TabRef[];
  renderTab: (tab: TabRef, group: GroupNode) => ReactNode;
  renderCell: (tab: TabRef, state: CellState) => ReactNode;
  cellClass?: (tab: TabRef) => string;
  /** The start page and its tab, offered while no terminal or preview is open. */
  start?: { tab: (selected: boolean, select: () => void) => ReactNode; page: ReactNode };
  /** A tab dropped outside the app window. Tabs that cannot leave simply stay. */
  detach: (key: string) => void;
}) {
  const { layout, zoomed } = workspace;
  const canvasRef = useRef<HTMLDivElement>(null);
  const canvas = useElementSize(canvasRef);
  const root = displayRoot(layout, { zoomed, narrow });
  const drag = useTabDrag({
    canvas: canvasRef,
    layout,
    root,
    allowSplit: !narrow,
    drop: workspace.drop,
    detach,
    finished: focusActiveTerminal,
  });
  const preview = drag.view?.target ? dropPreviewRect(root, drag.view.target) : null;
  const shownRects = rects(root);
  const rectOf = new Map(shownRects.map((rect) => [rect.id, rect]));
  const shownGroups = groups(root);
  const startGroup = start ? groups(layout.root)[0] : undefined;
  const nextGroup = (group: GroupNode) => {
    const list = groups(layout.root);
    const next = list[(list.findIndex((g) => g.id === group.id) + 1) % list.length];
    workspace.focus(next.id);
  };
  return (
    <div className="terminal-grid" ref={canvasRef}>
      {shownGroups.map((group) => {
        const focused = group.id === layout.focused;
        return (
          <GroupTabBar
            key={group.id}
            group={group}
            focused={focused}
            style={barStyle(rectOf.get(group.id)!)}
            renderTab={renderTab}
            start={
              group === startGroup
                ? start!.tab(!group.active, () => workspace.leave(group.id))
                : undefined
            }
            focusGroup={() => workspace.focus(group.id)}
            toggleZoom={workspace.toggleZoom}
            nextGroup={narrow && workspace.groupCount > 1 ? () => nextGroup(group) : undefined}
            onTabPointerDown={drag.onTabPointerDown}
          />
        );
      })}
      {order.map((tab) => {
        const key = tabKey(tab);
        const group = groupOfTab(layout.root, key);
        const rect = group && rectOf.get(group.id);
        const visible = !!rect && group.active === key;
        const focused = visible && group.id === layout.focused;
        return (
          <div
            key={key}
            className={`pane-cell ${focused ? 'focused' : ''} ${cellClass?.(tab) ?? ''}`}
            hidden={!visible}
            style={rect ? bodyStyle(rect) : undefined}
            onFocusCapture={() => workspace.focusTab(key)}
            onPointerDown={() => workspace.focusTab(key)}
          >
            {renderCell(tab, { visible, focused })}
          </div>
        );
      })}
      {shownGroups
        .filter((group) => !group.active)
        .map((group) => {
          const rect = rectOf.get(group.id)!;
          return group === startGroup ? (
            <div key="start" className="pane-cell start-cell" style={bodyStyle(rect)}>
              {start!.page}
            </div>
          ) : (
            <div
              key={group.id}
              className="pane-cell empty-cell"
              style={bodyStyle(rect)}
              onPointerDown={() => workspace.focus(group.id)}
            >
              <p>빈 칸입니다. 새 탭이 여기에 열립니다.</p>
              {!group.tabs.length && (
                <button onClick={() => workspace.closeEmpty(group.id)}>칸 닫기</button>
              )}
            </div>
          );
        })}
      {dividers(root).map((divider) => {
        const range = dividerRange(root, divider, canvas);
        const row = divider.dir === 'row';
        return (
          <ResizeHandle
            key={`${divider.path.join('.')}:${divider.index}`}
            className="pane-divider"
            label="칸 크기 조절"
            horizontal={!row}
            value={range?.value ?? 0}
            min={range ? Math.min(range.min, range.max) : 0}
            max={range?.max ?? 0}
            onChange={(px) => workspace.resizeDivider(divider, px, canvas)}
            onReset={() => workspace.equalizeSplit(divider.path)}
            style={
              row
                ? {
                    left: `calc(${divider.x * 100}% - 3px)`,
                    top: `${divider.y * 100}%`,
                    width: 6,
                    height: `${divider.length * 100}%`,
                  }
                : {
                    left: `${divider.x * 100}%`,
                    top: `calc(${divider.y * 100}% - 3px)`,
                    width: `${divider.length * 100}%`,
                    height: 6,
                  }
            }
          />
        );
      })}
      {preview && drag.view?.target && (
        <div
          className="drop-preview"
          data-zone={drag.view.target.zone}
          style={{
            left: `${preview.x * 100}%`,
            top: `${preview.y * 100}%`,
            width: `${preview.w * 100}%`,
            height: `${preview.h * 100}%`,
          }}
        />
      )}
      {drag.view?.insert && (
        <div
          className="drop-insert"
          style={{ left: drag.view.insert.x, top: drag.view.insert.y, height: TAB_BAR_HEIGHT }}
        />
      )}
      {drag.view && (
        <div
          className="tab-drag-label"
          style={{ left: drag.view.clientX + 12, top: drag.view.clientY + 12 }}
        >
          {drag.view.title}
        </div>
      )}
    </div>
  );
}
