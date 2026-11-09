import { describe, expect, it } from 'vitest';
import { NotificationLimiter, notificationBody } from './notifications';

describe('notification limits', () => {
  it('allows one per tab in five seconds', () => {
    const limiter = new NotificationLimiter();
    const tab = {};
    expect(limiter.allow(tab, 0)).toBe(true);
    expect(limiter.allow(tab, 4999)).toBe(false);
    expect(limiter.allow(tab, 5000)).toBe(true);
  });

  it('allows one across the app in two seconds', () => {
    const limiter = new NotificationLimiter();
    expect(limiter.allow({}, 0)).toBe(true);
    expect(limiter.allow({}, 1999)).toBe(false);
    expect(limiter.allow({}, 2000)).toBe(true);
  });

  it('does not count a refused notification against the tab', () => {
    const limiter = new NotificationLimiter();
    const tab = {};
    expect(limiter.allow({}, 0)).toBe(true);
    expect(limiter.allow(tab, 1000)).toBe(false);
    expect(limiter.allow(tab, 2000)).toBe(true);
  });
});

describe('notification text', () => {
  it('removes control and hidden characters and shortens the body', () => {
    expect(notificationBody('a\nb‮c\u0007')).toBe('abc');
    expect(notificationBody('x'.repeat(500))).toHaveLength(200);
  });
});
