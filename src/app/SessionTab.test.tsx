// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSession } from '../features/terminal/session';
import { ProgramStatus } from '../features/terminal/programStatus';
import { AgentSignQueue } from '../features/terminal/agentSign';
import { SessionTab } from './SessionTab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../lib/ipc', () => ({
  call: vi.fn(() => Promise.resolve()),
  errorText: (e: unknown) => String(e),
}));

function setup() {
  const programStatus = new ProgramStatus();
  const state = { status: 'connected' };
  const profile = { name: 'server' };
  const agentSign = new AgentSignQueue({
    terminal: { textarea: null } as unknown as Terminal,
    profile,
    notice: () => {},
  });
  const session = {
    programStatus,
    agentSign,
    connectionId: 'c1',
    profile,
    subscribe: () => () => {},
    snapshot: () => state,
  } as unknown as TerminalSession;
  const host = document.createElement('div');
  const root = createRoot(host);
  roots.push(root);
  const render = (active: boolean) =>
    act(() =>
      root.render(
        <SessionTab session={session} active={active} select={() => {}} close={() => {}} />,
      ),
    );
  const report = (body: string) => act(() => programStatus.report(body));
  // A connected tab shows a dot and names its state for screen readers; a program shows its badge.
  const label = () => host.querySelector('[role=tab] small, [role=tab] .sr-only')?.textContent;
  return { programStatus, agentSign, render, report, label };
}
const roots: Root[] = [];

describe('session tab status', () => {
  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
  });

  it('keeps a result on the open tab until the user acts', async () => {
    const { programStatus, render, report, label } = setup();
    await render(true);
    expect(label()).toBe('연결됨');
    await report('state=working');
    expect(label()).toBe('작업 중');
    await report('state=done');
    expect(label()).toBe('완료');
    await act(() => programStatus.acknowledge());
    expect(label()).toBe('연결됨');
  });

  it('clears a result when its tab is opened', async () => {
    const { render, report, label } = setup();
    await render(false);
    await report('state=done');
    expect(label()).toBe('완료');
    await render(true);
    expect(label()).toBe('연결됨');
  });

  it('keeps showing a program that waits for the user when its tab is opened', async () => {
    const { render, report, label } = setup();
    await render(false);
    await report('state=blocked');
    await render(true);
    expect(label()).toBe('입력 대기');
  });

  it('shows a sign request on its own connection as waiting for the user', async () => {
    const { agentSign, render, label } = setup();
    await render(false);
    const request = (id: string, owner: string) =>
      act(() =>
        agentSign.add(
          {
            type: 'agentSign',
            request: id,
            session: 'server',
            key: 'k',
            fingerprint: 'f',
            loginUser: null,
            namespace: null,
            hostKey: null,
            source: 'system',
            local: false,
            passphrase: false,
            seconds: 60,
          },
          owner,
        ),
      );
    await request('old', 'before-reconnect');
    expect(label()).toBe('연결됨');
    await request('now', 'c1');
    expect(label()).toBe('입력 대기');
    const now = agentSign.snapshot()[1];
    if (now.type !== 'agentSign') throw new Error('a sign request');
    await act(() => agentSign.answer(now, { decision: 'deny' }));
    expect(label()).toBe('연결됨');
  });
});
