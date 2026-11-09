import { useCallback, useEffect, useRef, useState } from 'react';
import { call, errorText } from '../../lib/ipc';
import { appNotificationLimiter } from '../../lib/notifications';
import type { IssueLog } from './history';
import { alertMessage, readAlertPref, writeAlertPref } from './problemAlerts';
import type { Problem } from './problems';

export function useAlertPref(session: string) {
  const [on, setOn] = useState(() => readAlertPref(session));
  const change = useCallback(
    (next: boolean) => {
      setOn(next);
      writeAlertPref(session, next);
    },
    [session],
  );
  return [on, change] as const;
}

/**
 * Sends new problems to the OS through the app's shared rate limit. What the limit refuses waits
 * and goes with the next poll, because a problem must not vanish for arriving at a busy moment.
 * Returns why the last notification failed.
 */
export function useProblemAlerts(
  issues: IssueLog,
  enabled: boolean,
  sessionName: string,
  onScreen: boolean,
) {
  const [error, setError] = useState('');
  const handled = useRef(0);
  const waiting = useRef<Problem[]>([]);
  const limiterKey = useRef({});

  useEffect(() => {
    const fresh = issues.alerts.filter((alert) => alert.id > handled.current);
    handled.current = issues.alerts.at(-1)?.id ?? handled.current;
    // Turning alerts on must not report what happened while they were off.
    if (!enabled) {
      waiting.current = [];
      return;
    }
    waiting.current.push(...fresh.map((alert) => alert.problem));
    if (!waiting.current.length) return;
    // The user is already looking at this workspace, and the list and its count show the problem.
    if (onScreen && document.hasFocus()) {
      waiting.current = [];
      return;
    }
    if (!appNotificationLimiter.allow(limiterKey.current, Date.now())) return;
    const message = alertMessage(sessionName, waiting.current);
    waiting.current = [];
    setError('');
    void call('notification_show', message).catch((e: unknown) => setError(errorText(e)));
  }, [issues, enabled, sessionName, onScreen]);

  return error;
}
