import { notificationBody } from '../../lib/notifications';
import type { Problem } from './problems';

const storageKey = (session: string) => `dachsterm.kube.alerts.${session}`;
const SHOWN_IN_BODY = 5;

/** Off unless this session turned it on. An unsaved tab has nowhere to remember it. */
export function readAlertPref(session: string) {
  if (!session) return false;
  try {
    return localStorage.getItem(storageKey(session)) === '1';
  } catch {
    return false;
  }
}

export function writeAlertPref(session: string, on: boolean) {
  if (!session) return;
  try {
    if (on) localStorage.setItem(storageKey(session), '1');
    else localStorage.removeItem(storageKey(session));
  } catch {
    // The switch still works for this tab; a full or blocked store only loses it for next time.
  }
}

/** The title comes from the app. Only the body carries cluster text, and it is cleaned first. */
export function alertMessage(sessionName: string, problems: Problem[]) {
  const shown = problems.slice(0, SHOWN_IN_BODY).map((p) => `${p.object} ${p.detail}`);
  const more = problems.length - shown.length;
  return {
    title: `${sessionName} — 쿠버네티스 문제 ${problems.length}건`,
    body: notificationBody(shown.join(' · ') + (more > 0 ? ` 외 ${more}건` : '')),
  };
}
