import { useEffect, useSyncExternalStore } from 'react';
import type { TerminalSession } from '../features/terminal/session';
import {
  programSummaryText,
  StatusBadge,
  useProgramSummary,
} from '../features/terminal/StatusBadge';
import { isRecording, useLogStatus } from '../features/terminal/logStatus';
import { useSignWaiting } from '../features/terminal/agentSign';
import { capabilities } from '../features/terminal/sessionKind';
import { gitSentence, gitTooltip } from '../features/git/gitStatus';
import { gitStatusOf, useGitStatus } from '../features/git/useGitStatus';
import { tabKey } from './workspaceLayout';

/** A shape with the word, so a state never depends on color alone. Connected is the quiet dot. */
const labels: Record<string, [string, string]> = {
  connecting: ['◌', '접속 중'],
  authenticating: ['◌', '인증 중'],
  trust: ['◌', '키 확인'],
  connected: ['', '연결됨'],
  closed: ['■', '종료'],
  error: ['▲', '오류'],
};
/** After the name, so a screen reader hears "server, connected" as before. */
function ConnectionMark({ status }: { status: string }) {
  const [shape, label] = labels[status] ?? ['◌', status];
  if (!shape) return <span className="sr-only">{label}</span>;
  return (
    <small className={`tab-state ${status}`}>
      {shape} {label}
    </small>
  );
}

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
  const log = useLogStatus(capabilities(session).log ? session.connectionId : null);
  // Opening the tab counts as seeing a result, whichever way the user got here. A result arriving
  // on the open tab stays until the user acts, since they may be looking at another window.
  useEffect(() => {
    if (active) session.programStatus.acknowledge();
  }, [active, session]);
  const git = useGitStatus(session);
  const gitView = git?.view;
  const repo = gitView && 'repo' in gitView ? gitView.repo : null;
  useEffect(() => {
    if (active) gitStatusOf(session)?.request('activate');
  }, [active, session]);
  const signing = useSignWaiting(session.agentSign, session.connectionId);
  const program = state.status === 'connected' ? (signing ?? summary) : null;
  // The branch shows in the status bar; the tab carries it only for its name and tooltip.
  const label = [
    session.profile.name,
    program && programSummaryText(program),
    repo && gitSentence(repo),
  ].filter(Boolean);
  return (
    <div
      className={`session-tab ${active ? 'selected' : ''}`}
      data-tab-key={tabKey({ kind: 'session', tabId: session.tabId })}
    >
      <button
        role="tab"
        aria-selected={active}
        aria-label={label.length > 1 ? label.join(' ') : undefined}
        title={repo ? gitTooltip(repo) : undefined}
        onClick={select}
      >
        {!program && state.status === 'connected' && (
          <span className="tab-dot" aria-hidden="true" />
        )}
        {session.profile.name}
        {program ? <StatusBadge summary={program} /> : <ConnectionMark status={state.status} />}
        {isRecording(log) && (
          <small className="tab-rec" title="세션 기록 중">
            REC
          </small>
        )}
      </button>
      <button aria-label={`${session.profile.name} 탭 닫기`} onClick={close}>
        ×
      </button>
    </div>
  );
}
