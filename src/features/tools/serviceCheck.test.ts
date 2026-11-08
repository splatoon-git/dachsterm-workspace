import { describe, expect, it } from 'vitest';
import { hostPort, serviceSteps, serviceSummary, type ServiceReport } from './serviceCheck';

const report = (over: Partial<ServiceReport> = {}): ServiceReport => ({
  host: 'api.example.com',
  port: 443,
  outcome: 'open',
  detail: null,
  service: 'https',
  elapsedMs: 42,
  resolve: { kind: 'measured', addresses: ['203.0.113.40'], ms: 3 },
  connectMs: 12,
  tls: {
    version: '1.3',
    trust: 'trusted',
    failure: null,
    certificate: {
      subject: 'api.example.com',
      issuer: 'Example CA',
      notBefore: '2026-01-01',
      notAfter: '2027-01-31',
      names: ['api.example.com'],
      moreNames: 0,
      selfSigned: false,
    },
  },
  http: { version: '1.1', status: 200, reason: 'OK', server: 'nginx', location: null },
  banner: [],
  attempts: 2,
  ...over,
});

describe('serviceSummary', () => {
  it('says what answered in one line', () => {
    expect(serviceSummary(report())).toBe('연결됨 · HTTPS 200 · 42ms');
    expect(serviceSummary(report({ service: 'http', tls: null }))).toBe('연결됨 · HTTP 200 · 42ms');
    expect(serviceSummary(report({ service: 'banner', http: null, elapsedMs: 5 }))).toBe(
      '연결됨 · 배너 · 5ms',
    );
    expect(serviceSummary(report({ service: 'tls', http: null }))).toBe('연결됨 · TLS · 42ms');
  });
  it('does not name a service it could not identify', () => {
    expect(serviceSummary(report({ service: 'none', http: null, elapsedMs: null }))).toBe(
      '연결됨 · 서비스 확인 안 됨',
    );
  });
  it('uses the port check words when it did not connect', () => {
    expect(serviceSummary(report({ outcome: 'noResponse', elapsedMs: null }))).toBe('응답 없음');
    expect(
      serviceSummary(report({ outcome: 'unknown', detail: '서버가 이 연결을 금지했습니다.' })),
    ).toBe('확인 불가 · 서버가 이 연결을 금지했습니다.');
  });
});

describe('serviceSteps', () => {
  const rows = (over?: Partial<ServiceReport>) => Object.fromEntries(serviceSteps(report(over)));

  it('walks through a successful HTTPS check', () => {
    expect(serviceSteps(report())).toEqual([
      ['이름 해석', '203.0.113.40 · 3ms'],
      ['TCP 연결', '성공 · 12ms'],
      ['TLS', '1.3 · 인증서 2027-01-31 만료 · 신뢰 OK'],
      ['인증서 주체', 'api.example.com'],
      ['발급자', 'Example CA'],
      ['인증서 이름', 'api.example.com'],
      ['응답', 'HTTP/1.1 200 OK · Server: nginx'],
    ]);
  });
  it('words a self-signed certificate and its trust apart from the connection', () => {
    const tls = { ...report().tls!, trust: 'selfSigned' as const };
    expect(rows({ tls }).TLS).toBe('1.3 · 인증서 2027-01-31 만료 · 자체 서명(신뢰 안 됨)');
  });
  it('shows a server name resolved remotely with no time', () => {
    expect(rows({ resolve: { kind: 'onServer', addresses: ['10.0.0.5'] } })['이름 해석']).toBe(
      '10.0.0.5 · 서버에서 해석(시간 측정 불가)',
    );
    expect(rows({ resolve: { kind: 'onServer', addresses: [] } })['이름 해석']).toBe(
      '서버에서 해석(시간 측정 불가)',
    );
    expect(rows({ resolve: { kind: 'literal' } })['이름 해석']).toBeUndefined();
  });
  it('explains a failed handshake without a certificate', () => {
    const tls = { version: null, trust: null, certificate: null, failure: 'notTls' as const };
    expect(rows({ tls, service: 'none', http: null }).TLS).toBe('서버가 TLS로 답하지 않았습니다');
  });
  it('warns that a connection alone does not prove the service', () => {
    expect(rows({ service: 'none', http: null, tls: null }).판단).toContain('장비나 프록시');
    expect(rows().판단).toBeUndefined();
  });
  it('keeps a banner and counts names it could not list', () => {
    expect(rows({ banner: ['220 a', '220 b'] })['서버가 보낸 내용']).toBe('220 a\n220 b');
    const tls = report().tls!;
    const more = { ...tls, certificate: { ...tls.certificate!, moreNames: 3 } };
    expect(rows({ tls: more })['인증서 이름']).toBe('api.example.com 외 3개');
  });
  it('shows a redirect target', () => {
    const http = { version: '1.1', status: 301, reason: '', server: null, location: 'https://x/' };
    expect(rows({ http }).응답).toBe('HTTP/1.1 301 · Location: https://x/');
  });
});

describe('hostPort', () => {
  it('brackets only an IPv6 address', () => {
    expect(hostPort('db.example', 5432)).toBe('db.example:5432');
    expect(hostPort('::1', 22)).toBe('[::1]:22');
  });
});
