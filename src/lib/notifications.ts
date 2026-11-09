const tabIntervalMs = 5000;
const appIntervalMs = 2000;
const maxBody = 200;
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

/** One instance for the whole app, so the app-wide interval holds across features. */
export const appNotificationLimiter = new NotificationLimiter();

/** Server text goes into an OS notification, so what could disguise it is removed first. */
export const notificationBody = (text: string) =>
  text.replace(unsafeCharacters, '').slice(0, maxBody);
