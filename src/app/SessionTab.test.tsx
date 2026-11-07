// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalSession } from '../features/terminal/session';
import { ProgramStatus } from '../features/terminal/programStatus';
import { SessionTab } from './SessionTab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setup() {
  const programStatus = new ProgramStatus();
  const state = { status: 'connected' };
  const session = {
    programStatus,
    profile: { name: 'server' },
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
  const label = () => host.querySelector('[role=tab] small')?.textContent;
  return { programStatus, render, report, label };
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
});
