import { useEffect, useSyncExternalStore } from 'react';
import type { TerminalSession } from '../features/terminal/session';
import {
  programSummaryText,
  StatusBadge,
  useProgramSummary,
} from '../features/terminal/StatusBadge';
import { tabKey } from './workspaceLayout';

const labels: Record<string, string> = {
  connecting: '접속 중',
  authenticating: '인증 중',
  trust: '키 확인',
  connected: '연결됨',
  closed: '종료',
  error: '오류',
};

export function SessionTab({
  session,
  active,
  select,
  close,
}: {
  session: TerminalSession;
  active: boolean;
  select: () => void;
  close: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const summary = useProgramSummary(session.programStatus);
  // Opening the tab counts as seeing a result, whichever way the user got here. A result arriving
  // on the open tab stays until the user acts, since they may be looking at another window.
  useEffect(() => {
    if (active) session.programStatus.acknowledge();
  }, [active, session]);
  const program = state.status === 'connected' ? summary : null;
  return (
    <div
      className={`session-tab ${active ? 'selected' : ''}`}
      data-tab-key={tabKey({ kind: 'session', tabId: session.tabId })}
    >
      <button
        role="tab"
        aria-selected={active}
        aria-label={program ? `${session.profile.name} ${programSummaryText(program)}` : undefined}
        onClick={select}
      >
        {session.profile.name}
        {program ? <StatusBadge summary={program} /> : <small>{labels[state.status]}</small>}
      </button>
      <button aria-label={`${session.profile.name} 탭 닫기`} onClick={close}>
        ×
      </button>
    </div>
  );
}
