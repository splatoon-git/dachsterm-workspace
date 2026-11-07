import { useEffect } from 'react';
import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { gitStatusText } from '../features/git/gitStatus';
import { gitStatusOf } from '../features/git/useGitStatus';
import { signWaiting } from '../features/terminal/agentSign';
import type { TerminalSession } from '../features/terminal/session';
import { programSummaryText } from '../features/terminal/StatusBadge';
import { desktop } from '../lib/ipc';
import {
  agentStatusEvent,
  type AgentReport,
  type AgentState,
  type AgentStatusMessage,
} from './agentRows';

/** When each tab entered the state it reports now. Kept per window, beside its sessions. */
const began = new WeakMap<TerminalSession, { state: AgentState; since: number }>();

/**
 * What a tab reports, the way its tab shows it: a key sign request before the program's own
 * state, and nothing unless connected. The branch is the tab's last Git result; nothing is asked.
 */
export function agentReportOf(session: TerminalSession, now = Date.now()): AgentReport | null {
  const { status, directory } = session.snapshot();
  const summary =
    status === 'connected'
      ? (signWaiting(session.agentSign.snapshot(), session.connectionId) ??
        session.programStatus.snapshot())
      : null;
  if (!summary) {
    began.delete(session);
    return null;
  }
  let start = began.get(session);
  if (start?.state !== summary.state)
    began.set(session, (start = { state: summary.state, since: now }));
  const view = gitStatusOf(session)?.scheduler.view(directory);
  return {
    name: session.profile.name,
    state: summary.state,
    since: start.since,
    git: view && 'repo' in view ? gitStatusText(view.repo) : '',
    detail: programSummaryText(summary),
  };
}

/** Calls back whenever something a report is made of may have changed. */
export function watchAgentReport(session: TerminalSession, changed: () => void) {
  const stops = [
    session.subscribe(changed),
    session.programStatus.subscribe(changed),
    session.agentSign.subscribe(changed),
  ];
  const git = gitStatusOf(session);
  if (git) stops.push(git.subscribe(changed));
  return () => stops.forEach((stop) => stop());
}

/**
 * An independent window tells the main window what its tab reports, as plain display text. The
 * main window drops the row when this window is destroyed, so a lost last message does no harm.
 */
export function useAgentStatusReport(session: TerminalSession | null) {
  useEffect(() => {
    if (!session || !desktop) return;
    const window = getCurrentWindow().label;
    let last = '';
    const send = (report: AgentReport | null) => {
      const message: AgentStatusMessage = { window, report };
      const text = JSON.stringify(message);
      if (text === last) return;
      last = text;
      // Only the list in the main window misses this update; the tab itself is unaffected.
      emitTo('main', agentStatusEvent, message).catch(() => {});
    };
    const stop = watchAgentReport(session, () => send(agentReportOf(session)));
    send(agentReportOf(session));
    return () => {
      stop();
      send(null);
    };
  }, [session]);
}
