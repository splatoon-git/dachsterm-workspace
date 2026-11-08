import { describe, expect, it } from 'vitest';
import {
  finishesAfterRecheck,
  kubeDisplay,
  kubeMenu,
  opensDirectly,
  settingsFrom,
  setupGuide,
  setupStep,
  type Detection,
  type KubeState,
} from './kubeModel';

const detection = (state: KubeState, patch: Partial<Detection> = {}): Detection => ({
  state,
  kubectl: '/usr/bin/kubectl',
  kubeconfig: '/etc/k.yaml',
  context: 'dev',
  contexts: ['dev', 'prod'],
  namespaces: [],
  namespacesForbidden: false,
  ...patch,
});

const saved = { context: 'dev', namespace: '', kubectl: '/k', kubeconfig: '/c', operate: false };

describe('setup steps', () => {
  it('picks the screen for each state', () => {
    expect(setupStep(detection({ kind: 'ready' }))).toBe('choose');
    expect(setupStep(detection({ kind: 'unreachable' }))).toBe('choose');
    expect(setupStep(detection({ kind: 'contextMissing' }))).toBe('choose');
    expect(setupStep(detection({ kind: 'configUnreadable' }))).toBe('copy');
    expect(setupStep(detection({ kind: 'authFailed' }))).toBe('copy');
    expect(setupStep(detection({ kind: 'kubectlMissing' }))).toBe('manual');
    expect(setupStep(detection({ kind: 'configMissing' }))).toBe('manual');
    expect(setupStep(detection({ kind: 'channelLimit' }))).toBe('retry');
    expect(setupStep(detection({ kind: 'unknown', message: 'x' }))).toBe('retry');
  });

  it('asks for a manual path when there is no context to choose', () => {
    expect(setupStep(detection({ kind: 'contextMissing' }, { contexts: [] }))).toBe('manual');
    expect(setupStep(detection({ kind: 'ready' }, { contexts: [] }))).toBe('manual');
  });

  it('tells the account how to get a readable config', () => {
    expect(setupGuide({ kind: 'configUnreadable' })?.title).toBe(
      '이 계정은 쿠버네티스 설정을 읽을 수 없습니다',
    );
    expect(setupGuide({ kind: 'authFailed' })?.body).toContain('복사본이 낡았을 수');
    expect(setupGuide({ kind: 'unknown', message: 'kubectl says no' })?.body).toBe(
      'kubectl says no',
    );
    expect(setupGuide({ kind: 'ready' })).toBeNull();
  });
});

describe('opening', () => {
  it('opens a saved session unless it needs attention', () => {
    expect(opensDirectly(detection({ kind: 'ready' }, { saved }))).toBe(true);
    expect(opensDirectly(detection({ kind: 'unreachable' }, { saved }))).toBe(true);
    expect(opensDirectly(detection({ kind: 'authFailed' }, { saved }))).toBe(false);
    expect(opensDirectly(detection({ kind: 'contextMissing' }, { saved }))).toBe(false);
    expect(opensDirectly(detection({ kind: 'configUnreadable' }, { saved }))).toBe(false);
  });

  it('always asks on the first connection', () => {
    expect(opensDirectly(detection({ kind: 'ready' }))).toBe(false);
  });

  it('finishes a recheck by itself only when one context leaves nothing to choose', () => {
    expect(finishesAfterRecheck(detection({ kind: 'ready' }, { contexts: ['one'] }))).toBe(true);
    expect(finishesAfterRecheck(detection({ kind: 'ready' }))).toBe(false);
    expect(finishesAfterRecheck(detection({ kind: 'authFailed' }, { contexts: ['one'] }))).toBe(
      false,
    );
  });

  it('never turns on operate mode', () => {
    expect(settingsFrom(detection({ kind: 'ready' }), 'prod', 'web')).toEqual({
      context: 'prod',
      namespace: 'web',
      kubectl: '/usr/bin/kubectl',
      kubeconfig: '/etc/k.yaml',
      operate: false,
    });
  });
});

describe('display', () => {
  const facts = { workspace: 'kubernetes' as const, opened: false, onTerminal: false };

  it('keeps the terminal until the connection is up', () => {
    expect(kubeDisplay({ ...facts, connected: false })).toBe('off');
    expect(kubeDisplay({ ...facts, connected: true })).toBe('workspace');
  });

  it('switches to the server terminal without closing the workspace', () => {
    expect(kubeDisplay({ ...facts, onTerminal: true, connected: true })).toBe('terminal');
  });

  it('shows a terminal session only when its menu opened the workspace', () => {
    const terminal = { ...facts, workspace: undefined, connected: true };
    expect(kubeDisplay(terminal)).toBe('off');
    expect(kubeDisplay({ ...terminal, opened: true })).toBe('workspace');
  });

  it('offers the menu entry a terminal session can use', () => {
    expect(kubeMenu('terminal', false)).toBe('open');
    expect(kubeMenu(undefined, true)).toBe('close');
    expect(kubeMenu('kubernetes', false)).toBe('fixed');
  });
});
