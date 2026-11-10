import { clampFontSize, saveTerminalDisplay, terminalDisplay } from './preferences';

/** A pause this long ends a wheel gesture; the next event starts a new one. */
export const wheelGestureGapMs = 120;
/** Less than this in a gesture is a resting finger's jitter, not a request. */
const minimumPixels = 4;
/** How far one line or page of a non-pixel wheel event counts, so any notch reaches the minimum. */
const pixelsPerUnit = 16;

/**
 * One gesture changes the size by one step, however far it scrolls. A smooth-scrolling mouse turns
 * one notch into a burst of events, and a trackpad keeps sending its momentum after the fingers
 * lift; counting their distance made one notch jump several sizes. A pause or a reversal starts the
 * next gesture, so notch by notch still moves step by step.
 */
export function fontSizeWheelStepper() {
  let direction = 0;
  let last = -Infinity;
  let pending = 0;
  let stepped = false;
  return (deltaY: number, size: number, time: number) => {
    const sign = Math.sign(deltaY);
    if (!sign) return size;
    if (time - last > wheelGestureGapMs || sign !== direction) {
      pending = 0;
      stepped = false;
    }
    direction = sign;
    last = time;
    if (stepped) return size;
    pending += Math.abs(deltaY);
    if (pending < minimumPixels) return size;
    stepped = true;
    return clampFontSize(size - sign);
  };
}

const wheelPixels = (event: WheelEvent) =>
  event.deltaMode === 0 ? event.deltaY : event.deltaY * pixelsPerUnit;

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
    const fontSize = step(wheelPixels(event), current, event.timeStamp);
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
