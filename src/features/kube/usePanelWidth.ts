import { useState } from 'react';

const WIDTH_KEY = 'dachsterm.kube.panelWidth';
export const PANEL_MIN_WIDTH = 280;
export const PANEL_MAX_WIDTH = 1400;
const DEFAULT_WIDTH = 520;

function readWidth() {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return saved >= PANEL_MIN_WIDTH && saved <= PANEL_MAX_WIDTH ? saved : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/** The side panel keeps one width, whichever screen it is opened from. */
export function usePanelWidth() {
  const [width, setWidth] = useState(readWidth);
  const change = (next: number) => {
    setWidth(next);
    try {
      localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      // The width is a convenience; a full or blocked store only forgets it.
    }
  };
  return { width, change };
}
