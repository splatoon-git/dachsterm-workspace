// @vitest-environment jsdom
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../../lib/ipc';
import { saveTerminalPreferences } from './preferences';
import {
  NotificationLimiter,
  notificationBody,
  notificationTitle,
  osc777Message,
  osc9Message,
  programNotifier,
} from './terminalNotify';

vi.mock('../../lib/ipc', () => ({
  call: vi.fn(() => Promise.resolve()),
  errorText: (e: unknown) => String(e),
}));

describe('deciding to notify', () => {
  const textarea = document.createElement('textarea');
  const other = document.createElement('input');
  document.body.append(textarea, other);
  const replay = { active: false };
  const notify = () =>
    programNotifier(
      {
        terminal: { textarea } as unknown as Terminal,
        sessionName: () => 'prod',
        replaying: () => replay.active,
        notice: vi.fn(),
      },
      new NotificationLimiter(),
    );
  beforeEach(() => {
    vi.mocked(call).mockClear();
    replay.active = false;
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    other.focus();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    saveTerminalPreferences({ osNotifications: true, bellNotifications: true });
  });

  it('notifies when the user is elsewhere, with a title from the app', () => {
    notify()('blocked', 'why');
    expect(call).toHaveBeenCalledExactlyOnceWith('notification_show', {
      title: 'prod — 입력 대기',
      body: 'why',
    });
  });

  it('stays quiet in the pane the user is looking at', () => {
    textarea.focus();
    notify()('blocked');
    expect(call).not.toHaveBeenCalled();
  });

  it('notifies from the focused pane when the whole window is in the background', () => {
    textarea.focus();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    notify()('done');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('never notifies for replayed output', () => {
    replay.active = true;
    notify()('blocked');
    expect(call).not.toHaveBeenCalled();
  });

  it('follows each setting', () => {
    saveTerminalPreferences({ bellNotifications: false });
    notify()('bell');
    expect(call).not.toHaveBeenCalled();
    notify()('done');
    expect(call).toHaveBeenCalledTimes(1);
    vi.mocked(call).mockClear();
    saveTerminalPreferences({ bellNotifications: true, osNotifications: false });
    notify()('done');
    expect(call).not.toHaveBeenCalled();
    notify()('bell');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('merges a status change and a bell from one event', () => {
    const fire = notify();
    fire('blocked');
    fire('bell');
    expect(call).toHaveBeenCalledTimes(1);
  });
});

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
  it('builds the title from the session name', () => {
    expect(notificationTitle('prod', 'blocked')).toBe('prod — 입력 대기');
    expect(notificationTitle('prod', 'done')).toBe('prod — 완료');
  });

  it('removes control and hidden characters and shortens the body', () => {
    expect(notificationBody('a\nb\u202ec\u0007')).toBe('abc');
    expect(notificationBody('x'.repeat(500))).toHaveLength(200);
  });
});

describe('notification sequences', () => {
  it('reads an OSC 9 message and skips numbered forms', () => {
    expect(osc9Message('Claude needs your permission')).toBe('Claude needs your permission');
    expect(osc9Message('4;1;50')).toBeNull();
    expect(osc9Message('9;/tmp')).toBeNull();
    expect(osc9Message('')).toBeNull();
  });

  it('reads an OSC 777 notify and leaves other forms alone', () => {
    expect(osc777Message('notify;Claude Code;needs you')).toBe('Claude Code · needs you');
    expect(osc777Message('notify;only title')).toBe('only title');
    expect(osc777Message('notify;t;a;b')).toBe('t · a;b');
    expect(osc777Message('DachsTerm;program;vim')).toBeNull();
  });
});
