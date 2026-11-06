import { clampFontSize, saveTerminalDisplay, terminalDisplay } from './preferences';

const wheelPixelsPerStep = 40;

/**
 * One mouse notch changes the size by one step, whatever its delta is. Trackpads and
 * high-resolution wheels emit small deltas, which add up to a step instead of each making one.
 */
export function fontSizeWheelStepper() {
  let pending = 0;
  return (deltaY: number, size: number) => {
    // A reversal responds at once instead of first cancelling what the last direction left over.
    pending = Math.sign(pending) === -Math.sign(deltaY) ? deltaY : pending + deltaY;
    if (Math.abs(pending) < wheelPixelsPerStep) return size;
    const next = clampFontSize(size - Math.sign(pending));
    pending = 0;
    return next;
  };
}

/** Ctrl/Cmd+wheel over a terminal changes the font size shared by all terminals. */
export function attachFontSizeWheel(element: HTMLElement, onSaveError: () => void) {
  const step = fontSizeWheelStepper();
  const wheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    // Runs in the capture phase so xterm neither scrolls nor reports the wheel to a TUI.
    // preventDefault needs a non-passive listener and keeps the webview from zooming the page.
    event.preventDefault();
    event.stopPropagation();
    const current = terminalDisplay().fontSize;
    const fontSize = step(event.deltaY, current);
    if (fontSize === current) return;
    try {
      saveTerminalDisplay({ fontSize });
    } catch {
      onSaveError();
    }
  };
  element.addEventListener('wheel', wheel, { capture: true, passive: false });
  return () => element.removeEventListener('wheel', wheel, { capture: true });
}
