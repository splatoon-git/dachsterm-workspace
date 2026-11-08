/** The port list, and the answer to "is this port in use". */
export type ListenerProcess =
  | { kind: 'known'; name: string; pid: number | null }
  | { kind: 'denied' }
  | { kind: 'unavailable' };
export type Listener = {
  protocol: 'tcp' | 'udp';
  address: string;
  port: number;
  process: ListenerProcess;
};
export type ListMethod =
  'windowsApi' | 'macLsof' | 'proc' | 'procSs' | 'procNetstat' | 'remoteLsof' | 'remoteNetstat';
export type ListenerReport = { method: ListMethod; listeners: Listener[] };

export const methodText: Record<ListMethod, string> = {
  windowsApi: 'Windows 소켓 표',
  macLsof: 'lsof · 다른 계정의 소켓은 보이지 않을 수 있습니다',
  proc: '/proc/net · 프로세스 이름을 읽을 도구가 없습니다',
  procSs: '/proc/net, ss',
  procNetstat: '/proc/net, netstat',
  remoteLsof: 'lsof · 다른 계정의 소켓은 보이지 않을 수 있습니다',
  remoteNetstat: 'netstat · 프로세스 이름은 나오지 않습니다',
};

export function processText(process: ListenerProcess) {
  if (process.kind === 'known')
    return process.pid === null ? process.name : `${process.name} (${process.pid})`;
  return process.kind === 'denied' ? '권한 없음' : '알 수 없음';
}

export type PortFilter = { ports: number[]; error: string | null };

/**
 * For narrowing a list already on screen. Port checks are parsed by the backend, which also enforces
 * their limits; this one tries nothing, so it is not the same rule.
 */
export function parsePortFilter(text: string): PortFilter {
  const ports = new Set<number>();
  const fail = (token: string): PortFilter => ({
    ports: [],
    error: `포트 형식이 잘못되었습니다: ${token}`,
  });
  const valid = (value: string) =>
    /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    const [first, last = first, extra] = token.split('-');
    if (extra !== undefined || !valid(first) || !valid(last) || Number(first) > Number(last))
      return fail(token);
    for (let port = Number(first); port <= Number(last); port++) ports.add(port);
  }
  return { ports: [...ports].sort((a, b) => a - b), error: null };
}

export function answerPorts(listeners: Listener[], ports: number[]) {
  const wanted = new Set(ports);
  const used = listeners.filter((listener) => wanted.has(listener.port));
  const taken = new Set(used.map((listener) => listener.port));
  return { used, unused: ports.filter((port) => !taken.has(port)) };
}

const SHOWN_UNUSED = 32;
export function unusedText(ports: number[]) {
  const shown = ports.slice(0, SHOWN_UNUSED).join(', ');
  return ports.length > SHOWN_UNUSED ? `${shown} 외 ${ports.length - SHOWN_UNUSED}개` : shown;
}
