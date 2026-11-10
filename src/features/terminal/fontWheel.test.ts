// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachFontSizeWheel, fontSizeWheelStepper, wheelGestureGapMs } from './fontWheel';
import { maxFontSize, minFontSize, saveTerminalDisplay, terminalDisplay } from './preferences';

describe('font size wheel stepper', () => {
  const gap = wheelGestureGapMs + 1;
  it('moves one step per notch whatever its delta, and grows when scrolling up', () => {
    const step = fontSizeWheelStepper();
    expect(step(-100, 14, 0)).toBe(15);
    expect(step(-600, 15, gap)).toBe(16);
    expect(step(100, 16, 2 * gap)).toBe(15);
  });
  it('takes a burst of events from one notch or a trackpad flick as one step', () => {
    // A smooth-scrolling mouse: one notch, many events a frame apart, adding up to 300px.
    const step = fontSizeWheelStepper();
    let size = 14;
    for (const [i, delta] of [-10, -40, -80, -70, -50, -30, -15, -5].entries())
      size = step(delta, size, i * 16);
    expect(size).toBe(15);
    // The momentum tail keeps coming without a pause and still counts as the same gesture.
    for (let t = 200; t < 1200; t += 16) size = step(-2, size, t);
    expect(size).toBe(15);
    expect(step(-40, size, 1200 + gap)).toBe(16);
  });
  it('ignores jitter below the minimum but adds it up within a gesture', () => {
    const step = fontSizeWheelStepper();
    expect(step(-1, 14, 0)).toBe(14);
    expect(step(-2, 14, 10)).toBe(14);
    expect(step(-1, 14, 20)).toBe(15);
    expect(step(-3, 14, 20 + gap)).toBe(14);
  });
  it('answers a reversal at once, even inside a burst', () => {
    const step = fontSizeWheelStepper();
    expect(step(-100, 14, 0)).toBe(15);
    expect(step(100, 15, 16)).toBe(14);
    expect(step(100, 14, 32)).toBe(14);
  });
  it('stays within the supported range', () => {
    const step = fontSizeWheelStepper();
    expect(step(-100, maxFontSize, 0)).toBe(maxFontSize);
    expect(step(100, minFontSize, gap)).toBe(minFontSize);
  });
});

describe('font size wheel listener', () => {
  const wheel = (init: WheelEventInit) =>
    new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  beforeEach(() => saveTerminalDisplay({ fontSize: 14 }));

  it('takes Ctrl and Cmd wheel from the terminal inside and blocks page zoom', () => {
    const parent = document.createElement('div');
    const inner = parent.appendChild(document.createElement('div'));
    const reachedTerminal = vi.fn();
    inner.addEventListener('wheel', reachedTerminal);
    const detach = attachFontSizeWheel(parent, () => {});
    const ctrl = wheel({ ctrlKey: true, deltaY: -100 });
    inner.dispatchEvent(ctrl);
    expect(terminalDisplay().fontSize).toBe(15);
    expect(ctrl.defaultPrevented).toBe(true);
    inner.dispatchEvent(wheel({ metaKey: true, deltaY: 100 }));
    expect(terminalDisplay().fontSize).toBe(14);
    expect(reachedTerminal).not.toHaveBeenCalled();
    // A line-based wheel reports 1 or 3 per notch; that is still a notch, not jitter.
    inner.dispatchEvent(wheel({ ctrlKey: true, deltaY: -1, deltaMode: 1 }));
    expect(terminalDisplay().fontSize).toBe(15);
    detach();
    inner.dispatchEvent(wheel({ ctrlKey: true, deltaY: 100 }));
    expect(terminalDisplay().fontSize).toBe(15);
  });
  it('leaves plain scrolling to the terminal', () => {
    const parent = document.createElement('div');
    const inner = parent.appendChild(document.createElement('div'));
    const reachedTerminal = vi.fn();
    inner.addEventListener('wheel', reachedTerminal);
    const detach = attachFontSizeWheel(parent, () => {});
    const plain = wheel({ deltaY: -100 });
    inner.dispatchEvent(plain);
    detach();
    expect(reachedTerminal).toHaveBeenCalledOnce();
    expect(plain.defaultPrevented).toBe(false);
    expect(terminalDisplay().fontSize).toBe(14);
  });
  it('reports a failed save and keeps the current size', () => {
    const parent = document.createElement('div');
    const onSaveError = vi.fn();
    const detach = attachFontSizeWheel(parent, onSaveError);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    parent.dispatchEvent(wheel({ ctrlKey: true, deltaY: -100 }));
    setItem.mockRestore();
    detach();
    expect(onSaveError).toHaveBeenCalledOnce();
    expect(terminalDisplay().fontSize).toBe(14);
  });
});
