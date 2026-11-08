/** A route trace as it arrives. Only says where replies stop, never who blocked anything. */
export type TraceMethod = 'icmp' | 'tcpPort' | 'udp' | 'tracepath';
export type TraceHop = {
  hop: number;
  address: string | null;
  rttMs: number | null;
  reached: boolean;
  unreachable: boolean;
};
export type TraceConclusion =
  | { kind: 'reached' }
  | { kind: 'lastResponder'; address: string }
  | { kind: 'noReply' }
  | { kind: 'unavailable' }
  | { kind: 'failed'; message: string };
export type TraceEvent =
  | { type: 'method'; method: TraceMethod }
  | { type: 'hop'; hop: TraceHop }
  | {
      type: 'finished';
      cancelled: boolean;
      conclusion: TraceConclusion | null;
      note: string | null;
    };

export type TraceState = {
  running: boolean;
  method: TraceMethod | null;
  hops: TraceHop[];
  conclusion: TraceConclusion | null;
  note: string | null;
  cancelled: boolean;
};

export const idleTrace: TraceState = {
  running: false,
  method: null,
  hops: [],
  conclusion: null,
  note: null,
  cancelled: false,
};

export const beginTrace = (): TraceState => ({ ...idleTrace, running: true });

export function applyTraceEvent(state: TraceState, event: TraceEvent): TraceState {
  if (event.type === 'method') return { ...state, method: event.method };
  if (event.type === 'hop') {
    const others = state.hops.filter((hop) => hop.hop !== event.hop.hop);
    return { ...state, hops: [...others, event.hop].sort((a, b) => a.hop - b.hop) };
  }
  return {
    ...state,
    running: false,
    cancelled: event.cancelled,
    conclusion: event.conclusion,
    note: event.note,
  };
}

export function conclusionText(conclusion: TraceConclusion): string {
  switch (conclusion.kind) {
    case 'reached':
      return '대상까지 도달했습니다.';
    case 'lastResponder':
      return `마지막 응답 장비는 ${conclusion.address}, 그 다음 구간에서 끊김`;
    case 'noReply':
      return '응답한 장비가 없습니다.';
    case 'unavailable':
      return '이 서버에서는 경로 추적을 할 수 없습니다';
    case 'failed':
      return conclusion.message;
  }
}

const REFERENCE_ONLY = '이 포트의 방화벽 정책과는 무관합니다.';
export const methodNote: Record<TraceMethod, string> = {
  icmp: `참고용 ICMP입니다. ${REFERENCE_ONLY}`,
  tcpPort: '점검한 포트로 보낸 TCP입니다.',
  udp: `참고용 UDP입니다. ${REFERENCE_ONLY}`,
  tracepath: `참고용 tracepath입니다. ${REFERENCE_ONLY}`,
};

export const hopDevice = (hop: TraceHop) => hop.address ?? '응답 없음';
export const hopTime = (hop: TraceHop) => (hop.rttMs === null ? '' : `${hop.rttMs}ms`);
export const hopNote = (hop: TraceHop) =>
  hop.reached ? '대상' : hop.unreachable ? '더 갈 경로가 없다고 응답' : '';
