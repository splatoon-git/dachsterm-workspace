import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { hitTest, type DropTarget, type TabEdge } from './workspaceDrop';
import { groupOfTab, type Layout, type LayoutNode } from './workspaceLayout';

const DRAG_THRESHOLD = 5;

export type TabDragView = {
  title: string;
  /** Pointer position in the window, for the label following it. */
  clientX: number;
  clientY: number;
  target: DropTarget | null;
  /** Insertion bar position in the workspace, while over a tab bar. */
  insert: { x: number; y: number } | null;
};
type DragOptions = {
  canvas: RefObject<HTMLElement | null>;
  layout: Layout;
  /** The groups on screen, which is one group while zoomed or narrow. */
  root: LayoutNode;
  allowSplit: boolean;
  drop: (key: string, target: DropTarget) => void;
  /** A tab dropped outside the app window. */
  detach: (key: string) => void;
  /** Runs after any drag that started, so the keyboard returns to the terminal. */
  finished: () => void;
};

function measureTabs(canvas: HTMLElement) {
  const origin = canvas.getBoundingClientRect();
  const edges: Record<string, TabEdge[]> = {};
  const bars: Record<string, { left: number; top: number }> = {};
  canvas.querySelectorAll<HTMLElement>('.tab-strip[data-group-id]').forEach((strip) => {
    const id = strip.dataset.groupId!;
    const bar = strip.getBoundingClientRect();
    bars[id] = { left: bar.left - origin.left, top: bar.top - origin.top };
    edges[id] = Array.from(
      strip.querySelectorAll<HTMLElement>('.session-tab[data-tab-key]'),
      (tab) => {
        const rect = tab.getBoundingClientRect();
        return { left: rect.left - origin.left, right: rect.right - origin.left };
      },
    );
  });
  return { origin, edges, bars };
}

// The browser still sends a click when the button is released over the captured tab.
function swallowNextClick() {
  const swallow = (click: MouseEvent) => {
    click.stopPropagation();
    click.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}

/**
 * Tab dragging on pointer events. HTML5 drag is not an option: file drops need Tauri's native drop
 * handler, which takes HTML5 drags away from the page on Windows, and WKWebView behaves differently.
 */
export function useTabDrag(options: DragOptions) {
  const [view, setView] = useState<TabDragView | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const stopCurrent = useRef<(() => void) | null>(null);
  useEffect(() => () => stopCurrent.current?.(), []);

  const onTabPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const pressed = event.target as HTMLElement;
    const button = pressed.closest('button');
    if (button && button.getAttribute('role') !== 'tab') return;
    const tab = pressed.closest<HTMLElement>('.session-tab[data-tab-key]');
    const key = tab?.dataset.tabKey;
    if (!tab || !key) return;
    const { pointerId, clientX: startX, clientY: startY } = event;
    const title = tab.querySelector('[role="tab"]')?.textContent?.trim() ?? '';
    let active = false;
    let target: DropTarget | null = null;

    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', keydown, true);
      document.body.classList.remove('tab-dragging');
      tab.classList.remove('dragged');
      if (tab.hasPointerCapture(pointerId)) tab.releasePointerCapture(pointerId);
      stopCurrent.current = null;
      setView(null);
    };
    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
        active = true;
        // Capture keeps the terminals it crosses from seeing the pointer, and reaches past the window.
        tab.setPointerCapture(pointerId);
        document.body.classList.add('tab-dragging');
        tab.classList.add('dragged');
      }
      const { canvas, layout, root, allowSplit } = latest.current;
      const element = canvas.current;
      const source = groupOfTab(layout.root, key);
      if (!element || !source) {
        target = null;
        setView(null);
        return;
      }
      const { origin, edges, bars } = measureTabs(element);
      target = hitTest({
        root,
        x: e.clientX - origin.left,
        y: e.clientY - origin.top,
        canvas: { width: origin.width, height: origin.height },
        viewport: {
          left: -origin.left,
          top: -origin.top,
          right: window.innerWidth - origin.left,
          bottom: window.innerHeight - origin.top,
        },
        source: { groupId: source.id, key },
        tabEdges: edges,
        allowSplit,
      });
      let insert: TabDragView['insert'] = null;
      if (target?.zone === 'tabbar') {
        const tabs = edges[target.groupId] ?? [];
        const bar = bars[target.groupId];
        const x = tabs[target.index]?.left ?? tabs[tabs.length - 1]?.right ?? bar?.left ?? 0;
        insert = { x, y: bar?.top ?? 0 };
      }
      setView({ title, clientX: e.clientX, clientY: e.clientY, target, insert });
    };
    const up = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const dragged = active;
      const dropped = target;
      stop();
      if (!dragged) return;
      swallowNextClick();
      const { drop, detach, finished } = latest.current;
      if (dropped?.zone === 'outside') detach(key);
      else if (dropped) drop(key, dropped);
      finished();
    };
    const cancel = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const dragged = active;
      stop();
      if (dragged) latest.current.finished();
    };
    // Only while dragging: before and after that, Escape belongs to the terminal.
    const keydown = (e: KeyboardEvent) => {
      if (!active || e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      stop();
      window.addEventListener('pointerup', swallowNextClick, { capture: true, once: true });
      latest.current.finished();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', keydown, true);
    stopCurrent.current = stop;
  };
  return { view, onTabPointerDown };
}
