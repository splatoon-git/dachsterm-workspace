// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { PendingSign } from '../features/terminal/agentSign';
import { ProgramStatus } from '../features/terminal/programStatus';
import type { TerminalSession } from '../features/terminal/session';
import { agentReportOf, watchAgentReport } from './agentStatus';

function store() {
  const listeners = new Set<() => void>();
  return {
    listeners,
    notify: () => listeners.forEach((listener) => listener()),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** Only what a report reads. FTP keeps the Git store out, which DX.5's own tests cover. */
function tab() {
  const signs = store();
  const states = store();
  let items: PendingSign[] = [];
  let state = { status: 'connected', directory: null as string | null };
  const session = {
    profile: { name: '배포 서버', protocol: 'ftp' },
    connectionId: 'c1',
    programStatus: new ProgramStatus(),
    agentSign: { snapshot: () => items, subscribe: signs.subscribe },
    snapshot: () => state,
    subscribe: states.subscribe,
  };
  return {
    session: session as unknown as TerminalSession,
    listening: () => signs.listeners.size + states.listeners.size,
    sign(owner: string) {
      items = [{ request: 'r', owner } as PendingSign];
      signs.notify();
    },
    status(status: string) {
      state = { ...state, status };
      states.notify();
    },
  };
}

describe('a tab in the agent list', () => {
  it('appears only while connected and reporting, with the tab tooltip text', () => {
    const t = tab();
    expect(agentReportOf(t.session, 10)).toBeNull();
    t.session.programStatus.report('state=working:id=a:msg=YnVpbGQ=');
    expect(agentReportOf(t.session, 20)).toEqual({
      name: '배포 서버',
      state: 'working',
      since: 20,
      git: '',
      detail: '작업 중 · build',
    });
    t.status('closed');
    expect(agentReportOf(t.session, 30)).toBeNull();
  });

  it('keeps the start of a state until the state changes', () => {
    const t = tab();
    t.session.programStatus.report('state=working:id=a');
    expect(agentReportOf(t.session, 100)?.since).toBe(100);
    t.session.programStatus.report('state=working:id=a:msg=YQ==');
    expect(agentReportOf(t.session, 200)?.since).toBe(100);
    t.session.programStatus.report('state=blocked:id=a:kind=question');
    expect(agentReportOf(t.session, 300)).toMatchObject({
      state: 'blocked',
      since: 300,
      detail: '입력 대기 · 답변 필요',
    });
  });

  it('shows a sign request on its own connection like a program waiting for input', () => {
    const t = tab();
    t.session.programStatus.report('state=working:id=a');
    t.sign('old-connection');
    expect(agentReportOf(t.session, 1)?.state).toBe('working');
    t.sign('c1');
    expect(agentReportOf(t.session, 2)).toMatchObject({
      state: 'blocked',
      detail: '입력 대기 · 키 서명 승인 요청',
    });
  });

  it('stops listening when the watch ends', () => {
    const t = tab();
    let calls = 0;
    const stop = watchAgentReport(t.session, () => calls++);
    expect(t.listening()).toBe(2);
    t.status('closed');
    t.sign('c1');
    t.session.programStatus.report('state=done:id=a');
    expect(calls).toBe(3);
    stop();
    t.status('connected');
    t.session.programStatus.report('state=working:id=a');
    expect(t.listening()).toBe(0);
    expect(calls).toBe(3);
  });
});
