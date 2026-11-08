import { outcomeLabel, type Outcome } from './portCheck';

/** One service check's answer. The backend decides what it means; this only words it. */
export type ServiceFormat = 'auto' | 'http' | 'https' | 'tls' | 'banner';
export type Service = 'http' | 'https' | 'tls' | 'banner' | 'none';
export type Resolve =
  | { kind: 'literal' }
  | { kind: 'measured'; addresses: string[]; ms: number }
  | { kind: 'onServer'; addresses: string[] }
  | { kind: 'unresolved' };
export type Trust =
  | 'trusted'
  | 'selfSigned'
  | 'unknownIssuer'
  | 'expired'
  | 'notYetValid'
  | 'nameMismatch'
  | 'invalid'
  | 'noRoots';
export type TlsFailure = 'notTls' | 'unsupported' | 'refused' | 'closed' | 'timedOut' | 'failed';
export type CertificateInfo = {
  subject: string | null;
  issuer: string | null;
  notBefore: string;
  notAfter: string;
  names: string[];
  moreNames: number;
  selfSigned: boolean;
};
export type TlsStep = {
  version: string | null;
  trust: Trust | null;
  certificate: CertificateInfo | null;
  failure: TlsFailure | null;
};
export type HttpReply = {
  version: string;
  status: number;
  reason: string;
  server: string | null;
  location: string | null;
};
export type ServiceReport = {
  host: string;
  port: number;
  outcome: Outcome;
  detail: string | null;
  service: Service;
  elapsedMs: number | null;
  resolve: Resolve;
  connectMs: number | null;
  tls: TlsStep | null;
  http: HttpReply | null;
  banner: string[];
  attempts: number;
};

export const formatChoices: { id: ServiceFormat; label: string }[] = [
  { id: 'auto', label: '자동' },
  { id: 'http', label: 'HTTP' },
  { id: 'https', label: 'HTTPS' },
  { id: 'tls', label: 'TLS' },
  { id: 'banner', label: 'TCP 배너' },
];

const trustLabel: Record<Trust, string> = {
  trusted: '신뢰 OK',
  selfSigned: '자체 서명(신뢰 안 됨)',
  unknownIssuer: '발급자를 신뢰할 수 없음',
  expired: '만료됨',
  notYetValid: '아직 유효 기간 전',
  nameMismatch: '이름이 인증서와 다름',
  invalid: '검증 실패',
  noRoots: '이 PC의 인증서 저장소를 읽지 못해 판단 불가',
};

const tlsFailureLabel: Record<TlsFailure, string> = {
  notTls: '서버가 TLS로 답하지 않았습니다',
  unsupported: '서버가 이 앱이 쓰는 TLS 1.2·1.3을 지원하지 않습니다',
  refused: '서버가 TLS 연결을 거절했습니다',
  closed: '서버가 연결을 닫았습니다',
  timedOut: 'TLS 응답 시간 초과',
  failed: 'TLS 연결을 맺지 못했습니다',
};

const NOT_IDENTIFIED =
  '연결은 되었지만 응답으로 서비스를 확인하지 못했습니다. 장비나 프록시가 대신 받았을 수 있습니다.';

const serviceName = (report: ServiceReport): string => {
  const status = report.http ? ` ${report.http.status}` : '';
  switch (report.service) {
    case 'http':
      return `HTTP${status}`;
    case 'https':
      return `HTTPS${status}`;
    case 'tls':
      return 'TLS';
    case 'banner':
      return '배너';
    case 'none':
      return '서비스 확인 안 됨';
  }
};

/** One line, such as `연결됨 · HTTPS 200 · 42ms`. */
export function serviceSummary(report: ServiceReport): string {
  if (report.outcome !== 'open')
    return [outcomeLabel[report.outcome], report.detail].filter(Boolean).join(' · ');
  const elapsed = report.elapsedMs === null ? '' : `${report.elapsedMs}ms`;
  return ['연결됨', serviceName(report), elapsed].filter(Boolean).join(' · ');
}

const resolveText = (resolve: Resolve): string | null => {
  switch (resolve.kind) {
    case 'measured':
      return `${resolve.addresses.join(', ')} · ${resolve.ms}ms`;
    case 'onServer':
      return resolve.addresses.length
        ? `${resolve.addresses.join(', ')} · 서버에서 해석(시간 측정 불가)`
        : '서버에서 해석(시간 측정 불가)';
    default:
      return null;
  }
};

const certificateNames = (info: CertificateInfo) =>
  [info.names.join(', '), info.moreNames ? `외 ${info.moreNames}개` : ''].filter(Boolean).join(' ');

function tlsText(tls: TlsStep): string {
  const parts = [
    tls.version,
    tls.certificate && `인증서 ${tls.certificate.notAfter} 만료`,
    tls.trust && trustLabel[tls.trust],
    tls.failure && tlsFailureLabel[tls.failure],
  ];
  return parts.filter(Boolean).join(' · ');
}

function replyText(reply: HttpReply): string {
  return [
    `HTTP/${reply.version} ${reply.status}${reply.reason ? ` ${reply.reason}` : ''}`,
    reply.server && `Server: ${reply.server}`,
    reply.location && `Location: ${reply.location}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The expanded rows, in the order the check went through them. */
export function serviceSteps(report: ServiceReport): [string, string][] {
  const rows: [string, string][] = [];
  const resolved = resolveText(report.resolve);
  if (resolved) rows.push(['이름 해석', resolved]);
  rows.push([
    'TCP 연결',
    report.outcome === 'open'
      ? `성공${report.connectMs === null ? '' : ` · ${report.connectMs}ms`}`
      : outcomeLabel[report.outcome],
  ]);
  if (report.tls) {
    rows.push(['TLS', tlsText(report.tls)]);
    const info = report.tls.certificate;
    if (info) {
      if (info.subject) rows.push(['인증서 주체', info.subject]);
      if (info.issuer) rows.push(['발급자', info.issuer]);
      const names = certificateNames(info);
      if (names) rows.push(['인증서 이름', names]);
    }
  }
  if (report.http) rows.push(['응답', replyText(report.http)]);
  if (report.banner.length) rows.push(['서버가 보낸 내용', report.banner.join('\n')]);
  if (report.outcome === 'open' && report.service === 'none') rows.push(['판단', NOT_IDENTIFIED]);
  return rows;
}

/** What a port check's row becomes as a target, with an IPv6 address in brackets. */
export const hostPort = (host: string, port: number) =>
  `${host.includes(':') ? `[${host}]` : host}:${port}`;
