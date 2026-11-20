import { describe, expect, it } from 'vitest';
import { fittedScale, percent, scaleOf, steppedZoom } from './zoom';

describe('preview zoom', () => {
  it('steps to the next size from a fitted scale', () => {
    expect(steppedZoom(0.83, 1)).toBe(0.9);
    expect(steppedZoom(0.83, -1)).toBe(0.75);
    expect(steppedZoom(1, 1)).toBe(1.25);
    expect(steppedZoom(1, -1)).toBe(0.9);
  });

  it('does not count a scale a hair from a step as another step', () => {
    expect(steppedZoom(0.9999, 1)).toBe(1.25);
    expect(steppedZoom(1.0001, -1)).toBe(0.9);
  });

  it('stops at both ends', () => {
    expect(steppedZoom(4, 1)).toBe(4);
    expect(steppedZoom(9, 1)).toBe(4);
    expect(steppedZoom(0.25, -1)).toBe(0.25);
    expect(steppedZoom(0.01, -1)).toBe(0.25);
  });

  it('fits a page to the room and stays inside the steps', () => {
    expect(fittedScale(400, 800)).toBe(0.5);
    expect(fittedScale(8000, 800)).toBe(4);
    expect(fittedScale(10, 800)).toBe(0.25);
    // Before the pane has been measured, and for a page that reports no size.
    expect(fittedScale(0, 800)).toBe(1);
    expect(fittedScale(400, 0)).toBe(1);
  });

  it('uses the fitted scale only while fitting', () => {
    expect(scaleOf({ kind: 'fit' }, 0.6)).toBe(0.6);
    expect(scaleOf({ kind: 'scale', value: 2 }, 0.6)).toBe(2);
    expect(percent(0.666)).toBe('67%');
  });
});
