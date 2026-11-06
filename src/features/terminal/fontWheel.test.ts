// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachFontSizeWheel, fontSizeWheelStepper } from './fontWheel';
import { maxFontSize, minFontSize, saveTerminalDisplay, terminalDisplay } from './preferences';

describe('font size wheel stepper', () => {
  it('moves one step per mouse notch and grows when scrolling up', () => {
    const step = fontSizeWheelStepper();
    expect(step(-100, 14)).toBe(15);
    expect(step(-600, 15)).toBe(16);
    expect(step(100, 16)).toBe(15);
  });
  it('adds small trackpad deltas up to one step', () => {
    const step = fontSizeWheelStepper();
    expect(step(-15, 14)).toBe(14);
    expect(step(-15, 14)).toBe(14);
    expect(step(-15, 14)).toBe(15);
    expect(step(-15, 15)).toBe(15);
  });
  it('drops the leftover of the previous direction on a reversal', () => {
    const step = fontSizeWheelStepper();
    expect(step(-30, 14)).toBe(14);
    expect(step(40, 14)).toBe(13);
  });
  it('stays within the supported range', () => {
    const step = fontSizeWheelStepper();
    expect(step(-100, maxFontSize)).toBe(maxFontSize);
    expect(step(100, minFontSize)).toBe(minFontSize);
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
    detach();
    inner.dispatchEvent(wheel({ ctrlKey: true, deltaY: -100 }));
    expect(terminalDisplay().fontSize).toBe(14);
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
