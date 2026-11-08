import { useCallback, useState, type CSSProperties } from 'react';

const openKey = 'dachsterm.gitView.graph';
const heightKey = 'dachsterm.gitView.changesHeight';
/** Each pane keeps at least a few rows, however the handle is dragged. */
const minPane = 72;

function readOpen() {
  try {
    return localStorage.getItem(openKey) !== 'false';
  } catch {
    // Storage can be blocked; the section is open by default.
    return true;
  }
}

function readHeight() {
  try {
    const value = Number(localStorage.getItem(heightKey));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    // Storage can be blocked; the panes then share the height evenly.
    return null;
  }
}

function save(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked; the layout simply is not remembered.
  }
}

/** The height the handle stands for: what was dragged, or half, inside what the panes allow. */
export function paneHeight(saved: number | null, total: number) {
  const max = Math.max(minPane, total - minPane);
  return { height: Math.min(max, Math.max(minPane, saved ?? total / 2)), min: minPane, max };
}

/** The changed files above the graph, and the handle between them. */
export function useGitPanes() {
  const [open, setOpenState] = useState(readOpen);
  const [saved, setSaved] = useState(readHeight);
  const [total, setTotal] = useState(0);
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(() => setTotal(node.clientHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const { height, min, max } = paneHeight(saved, total);
  // Until the first measurement, the stylesheet's equal shares are as good as any.
  const bodyStyle: CSSProperties | undefined =
    open && total > 0 ? { flex: `0 1 ${height}px` } : undefined;
  return {
    measure: ref,
    open,
    height,
    min,
    max,
    bodyStyle,
    setOpen: (next: boolean) => {
      setOpenState(next);
      save(openKey, String(next));
    },
    setHeight: (next: number) => {
      setSaved(next);
      save(heightKey, String(Math.round(next)));
    },
    reset: () => {
      setSaved(null);
      save(heightKey, null);
    },
  };
}
