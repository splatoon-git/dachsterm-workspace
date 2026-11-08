import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { desktop } from './ipc';

type Point = { x: number; y: number };

let draggingOut = false;
export const isDraggingOut = () => draggingOut;
/** Files this app is dragging out are not a drop on it, wherever the user lets go. */
export async function whileDraggingOut(work: () => Promise<void>) {
  draggingOut = true;
  try {
    await work();
  } finally {
    draggingOut = false;
  }
}

/** The window reports physical pixels; the page lays out in CSS pixels. */
export function insideElement(element: HTMLElement | null, position: Point, scale: number) {
  const rect = element?.getBoundingClientRect();
  if (!rect) return false;
  const x = position.x / scale;
  const y = position.y / scale;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Files dropped from the OS onto one element. The window takes every drop, so each view checks
 * the position itself; the result says whether a drag is over the element now, for its outline.
 */
export function useFileDrop(
  target: RefObject<HTMLElement | null>,
  drop: (paths: string[]) => void,
  enabled: boolean,
) {
  const [over, setOver] = useState(false);
  const latest = useRef(drop);
  useLayoutEffect(() => {
    latest.current = drop;
  });
  useEffect(() => {
    if (!desktop || !enabled) return;
    let off: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === 'leave' || draggingOut) return setOver(false);
        const hit = insideElement(target.current, payload.position, window.devicePixelRatio);
        if (payload.type !== 'drop') return setOver(hit);
        setOver(false);
        if (hit) latest.current(payload.paths);
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else off = unlisten;
      });
    return () => {
      disposed = true;
      off?.();
      setOver(false);
    };
  }, [enabled, target]);
  return over;
}
