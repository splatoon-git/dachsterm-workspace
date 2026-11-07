import { useSyncExternalStore } from 'react';
import type { ProgramStatus } from './programStatus';
import { programStateLabels, type ProgramSummary } from './programStatus';
import './agent.css';

const kindLabels: Record<NonNullable<ProgramSummary['kind']>, string> = {
  permission: '승인 필요',
  question: '답변 필요',
  auth: '인증 필요',
};

export const useProgramSummary = (status: ProgramStatus) =>
  useSyncExternalStore(status.subscribe, status.snapshot);

export function programSummaryText(summary: ProgramSummary) {
  const kind = summary.kind && kindLabels[summary.kind];
  return [programStateLabels[summary.state], kind, summary.detail].filter(Boolean).join(' · ');
}

/** Words carry the meaning and color only reinforces it. */
export function StatusBadge({ summary }: { summary: ProgramSummary }) {
  return (
    <small className={`program-status ${summary.state}`} title={programSummaryText(summary)}>
      {programStateLabels[summary.state]}
    </small>
  );
}
