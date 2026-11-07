import type { Terminal } from '@xterm/xterm';
import { call, errorText } from '../../lib/ipc';
import { terminalPreferences } from './preferences';

export type AttentionReason = 'blocked' | 'done' | 'error' | 'bell' | 'message';

const tabIntervalMs = 5000;
const appIntervalMs = 2000;
const maxBody = 200;
const reasonLabels: Record<AttentionReason, string> = {
  blocked: '입력 대기',
  done: '완료',
  error: '오류',
  bell: '알림',
  message: '알림',
};
const unsafeCharacters =
  // eslint-disable-next-line no-control-regex -- removing these is the point.
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/**
 * Limits how often notifications appear. A program often reports through two paths at once, such
 * as a status change and a bell. The per-tab interval also merges those into one notification.
 */
export class NotificationLimiter {
  private lastApp = -Infinity;
  private lastTab = new Map<object, number>();
  allow(tab: object, now: number) {
    if (now - this.lastApp < appIntervalMs) return false;
    if (now - (this.lastTab.get(tab) ?? -Infinity) < tabIntervalMs) return false;
    this.lastApp = now;
    this.lastTab.set(tab, now);
    return true;
  }
}

/** The title always comes from the app, so a server cannot pose as another tab. */
export const notificationTitle = (session: string, reason: AttentionReason) =>
  `${session} — ${reasonLabels[reason]}`;

export const notificationBody = (text: string) =>
  text.replace(unsafeCharacters, '').slice(0, maxBody);

/** OSC 9 messages. Numbered forms such as `4;` progress are other protocols, not messages. */
export function osc9Message(value: string) {
  return !value || /^\d+(;|$)/.test(value) ? null : value;
}

/** OSC 777 `notify;title;body`. */
export function osc777Message(value: string) {
  const match = /^notify;([^;]*);?(.*)$/s.exec(value);
  return match ? [match[1], match[2]].filter(Boolean).join(' · ') : null;
}

const sharedLimiter = new NotificationLimiter();

type NotifierHost = {
  terminal: Terminal;
  sessionName: () => string;
  replaying: () => boolean;
  notice: (message: string) => void;
};

export function programNotifier(host: NotifierHost, limiter = sharedLimiter) {
  return (reason: AttentionReason, detail = '') => {
    const preferences = terminalPreferences();
    const enabled = reason === 'bell' ? preferences.bellNotifications : preferences.osNotifications;
    if (!enabled || host.replaying()) return;
    // The user is already looking at this pane.
    if (document.hasFocus() && document.activeElement === host.terminal.textarea) return;
    if (!limiter.allow(host, Date.now())) return;
    void call('notification_show', {
      title: notificationTitle(host.sessionName(), reason),
      body: notificationBody(detail),
    }).catch((error) => host.notice(errorText(error)));
  };
}
