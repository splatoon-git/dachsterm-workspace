/** A port check's results as they arrive. The backend decides what is tried and what it means. */
export type Outcome =
  | 'open'
  | 'closed'
  | 'noResponse'
  | 'unreachable'
  | 'unknown'
  | 'closedOrUnreachable'
  | 'closedOrNoResponse';
export type CheckMethod = 'direct' | 'bash' | 'nc';
export type CheckPhase = 'probing' | 'confirming' | 'fallback';
export type CheckEvent =
  | {
      type: 'result';
      host: string;
      port: number;
      outcome: Outcome;
      detail: string | null;
      method: CheckMethod;
    }
  | { type: 'progress'; done: number; total: number; waiting: boolean; phase: CheckPhase }
  | { type: 'notice'; message: string }
  | { type: 'finished'; cancelled: boolean; message: string | null };
export type CheckStart =
  | { state: 'needsConfirmation'; hosts: number; ports: number; attempts: number }
  | { state: 'running' };

export type CheckRow = Omit<Extract<CheckEvent, { type: 'result' }>, 'type'> & {
  /** When the result arrived, in milliseconds. */
  at: number;
};
export type CheckState = {
  running: boolean;
  rows: CheckRow[];
  done: number;
  total: number;
  waiting: boolean;
  phase: CheckPhase;
  notice: string | null;
  ended: string | null;
  cancelled: boolean;
  /** Checking one row again: the rest of the list stays and its counts do not apply. */
  keep: boolean;
};

export const idleCheck: CheckState = {
  running: false,
  rows: [],
  done: 0,
  total: 0,
  waiting: false,
  phase: 'probing',
  notice: null,
  ended: null,
  cancelled: false,
  keep: false,
};

export const beginCheck = (state: CheckState, keep: boolean): CheckState =>
  keep
    ? { ...state, running: true, keep: true, ended: null, cancelled: false, waiting: false }
    : { ...idleCheck, running: true };

const rowKey = (row: { host: string; port: number }) => `${row.host}\n${row.port}`;
const order = (a: CheckRow, b: CheckRow) =>
  a.host.localeCompare(b.host, undefined, { numeric: true }) || a.port - b.port;

export function applyCheckEvents(state: CheckState, events: CheckEvent[], now: number): CheckState {
  const rows = new Map(state.rows.map((row) => [rowKey(row), row]));
  let next = state;
  for (const event of events) {
    if (event.type === 'result') {
      const { host, port, outcome, detail, method } = event;
      rows.set(rowKey(event), { host, port, outcome, detail, method, at: now });
    } else if (event.type === 'progress') {
      if (!next.keep)
        next = {
          ...next,
          done: event.done,
          total: event.total,
          waiting: event.waiting,
          phase: event.phase,
        };
    } else if (event.type === 'notice') {
      next = { ...next, notice: event.message };
    } else {
      next = {
        ...next,
        running: false,
        waiting: false,
        cancelled: event.cancelled,
        ended: event.message,
        keep: false,
      };
    }
  }
  return { ...next, rows: [...rows.values()].sort(order) };
}

export const outcomeLabel: Record<Outcome, string> = {
  open: '열림',
  closed: '닫힘',
  noResponse: '응답 없음',
  unreachable: '도달 불가',
  unknown: '확인 불가',
  closedOrUnreachable: '닫힘 또는 도달 불가',
  closedOrNoResponse: '닫힘 또는 응답 없음',
};

const outcomeNote: Record<Outcome, string> = {
  open: '',
  closed: '대상까지 닿았고 이 포트를 쓰는 프로그램이 없습니다.',
  noResponse: '방화벽 차단 가능성이 높습니다(확정 불가).',
  unreachable: '경로가 없다고 장비가 알렸습니다.',
  unknown: '',
  closedOrUnreachable: '결과가 많아 사유를 하나씩 확인하지 않았습니다.',
  closedOrNoResponse: '서버의 명령으로는 둘을 구분할 수 없습니다.',
};

const methodNote: Record<CheckMethod, string> = {
  direct: '',
  bash: '서버가 포워딩을 금지해 서버의 bash로 확인했습니다.',
  nc: '서버가 포워딩을 금지해 서버의 nc로 확인했습니다.',
};

export const rowNote = (row: CheckRow) =>
  [row.detail ?? outcomeNote[row.outcome], methodNote[row.method]].filter(Boolean).join(' ');

export function checkSummary(state: CheckState): string {
  if (state.running && !state.keep) {
    const count = `진행 ${state.done}/${state.total}`;
    if (state.waiting) return `${count} · 서버 응답 대기 중`;
    if (state.phase === 'confirming') return `${count} · 닫힘 사유 확인 중`;
    if (state.phase === 'fallback') return `${count} · 서버의 명령으로 확인 중`;
    return count;
  }
  if (!state.rows.length && !state.cancelled) return '';
  const open = state.rows.filter((row) => row.outcome === 'open').length;
  return `${state.rows.length}개 중 ${open}개 열림`;
}

/** Tab-separated, so it pastes into a spreadsheet: source, target, port, result, time. */
export const rowText = (row: CheckRow, source: string) =>
  [source, row.host, row.port, outcomeLabel[row.outcome], new Date(row.at).toLocaleString()].join(
    '\t',
  );
