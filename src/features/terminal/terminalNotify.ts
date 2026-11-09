import type { Terminal } from '@xterm/xterm';
import { call, errorText } from '../../lib/ipc';
import { appNotificationLimiter, notificationBody } from '../../lib/notifications';
import { terminalPreferences } from './preferences';

export type AttentionReason = 'blocked' | 'done' | 'error' | 'bell' | 'message' | 'command';

const reasonLabels: Record<AttentionReason, string> = {
  blocked: '입력 대기',
  done: '완료',
  error: '오류',
  bell: '알림',
  message: '알림',
  command: '명령 완료',
};
/** The title always comes from the app, so a server cannot pose as another tab. */
export const notificationTitle = (session: string, reason: AttentionReason) =>
  `${session} — ${reasonLabels[reason]}`;

/** OSC 9 messages. Numbered forms such as `4;` progress are other protocols, not messages. */
export function osc9Message(value: string) {
  return !value || /^\d+(;|$)/.test(value) ? null : value;
}

/** OSC 777 `notify;title;body`. */
export function osc777Message(value: string) {
  const match = /^notify;([^;]*);?(.*)$/s.exec(value);
  return match ? [match[1], match[2]].filter(Boolean).join(' · ') : null;
}

type NotifierHost = {
  terminal: Terminal;
  sessionName: () => string;
  replaying: () => boolean;
  notice: (message: string) => void;
};

export function programNotifier(host: NotifierHost, limiter = appNotificationLimiter) {
  return (reason: AttentionReason, detail = '') => {
    const preferences = terminalPreferences();
    const enabled =
      reason === 'bell'
        ? preferences.bellNotifications
        : reason === 'command'
          ? preferences.longCommandNotify > 0
          : preferences.osNotifications;
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
