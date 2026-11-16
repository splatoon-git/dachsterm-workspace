import { useSyncExternalStore } from 'react';
import { call, desktop } from '../../lib/ipc';

/** Mirrors `updates::Phase` in the backend. */
export type UpdatePhase =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'latest'; checked: number }
  | { state: 'available'; version: string; notes: string | null; date: string | null }
  | { state: 'downloading'; version: string; received: number; total: number | null }
  | { state: 'installing'; version: string }
  | { state: 'failed'; message: string };

export type UpdateStatus = {
  current: string;
  /** The app checks on start and once a day by itself. */
  auto: boolean;
  /** Why this build cannot update itself. */
  unavailable: string | null;
  phase: UpdatePhase;
};

/** The version waiting for the user or being installed, which the title bar points out. */
export function pendingVersion(phase: UpdatePhase): string | null {
  switch (phase.state) {
    case 'available':
    case 'downloading':
    case 'installing':
      return phase.version;
    default:
      return null;
  }
}

/**
 * The error a button's request returned, unless the phase already says the same thing: a failed
 * install is both the phase and the request's error.
 */
export const separateError = (phase: UpdatePhase, error: string) =>
  error && !(phase.state === 'failed' && phase.message === error) ? error : '';

export const isBusy = (phase: UpdatePhase) =>
  phase.state === 'checking' || phase.state === 'downloading' || phase.state === 'installing';

const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

export function progressText(phase: Extract<UpdatePhase, { state: 'downloading' }>) {
  if (!phase.total) return `${megabytes(phase.received)} MB 받음`;
  return `${megabytes(phase.received)} / ${megabytes(phase.total)} MB`;
}

/** Whole percent, or null while the size is unknown. */
export function progressPercent(phase: Extract<UpdatePhase, { state: 'downloading' }>) {
  if (!phase.total) return null;
  return Math.min(100, Math.floor((phase.received / phase.total) * 100));
}

export function checkedText(checked: number, now = new Date()) {
  const at = new Date(checked * 1000);
  const time = at.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === now.toDateString()
    ? `오늘 ${time}`
    : `${at.toLocaleDateString('ko-KR')} ${time}`;
}

let current: UpdateStatus | null = null;
const listeners = new Set<() => void>();
function publish(next: UpdateStatus) {
  current = next;
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Null until the first answer from the backend, and always outside the desktop app. */
export const useUpdateStatus = () => useSyncExternalStore(subscribe, () => current);

export async function loadUpdates() {
  if (!desktop) return;
  publish(await call<UpdateStatus>('update_status'));
}

/** `automatic` checks are skipped by the backend when the user turned them off. */
export async function checkUpdates(automatic: boolean) {
  if (!desktop) return;
  publish(await call<UpdateStatus>('update_check', { automatic }));
}

export async function setAutoUpdates(on: boolean) {
  publish(await call<UpdateStatus>('update_auto_set', { on }));
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Downloads and installs the update the last check found. The app restarts once it is in place,
 * so success never comes back here. Progress is read while the install runs, one request at a
 * time.
 */
export async function installUpdate() {
  let running = true;
  const install = call('update_install').finally(() => {
    running = false;
  });
  const watch = (async () => {
    while (running) {
      await pause(400);
      if (running) publish(await call<UpdateStatus>('update_status'));
    }
  })();
  try {
    await install;
  } finally {
    await watch.catch(() => undefined);
    await loadUpdates();
  }
}

const firstCheck = 10_000;
const daily = 24 * 60 * 60 * 1000;

/**
 * The automatic check: shortly after start, then once a day while the app stays open. The main
 * window runs it once; the backend skips it when the setting is off.
 */
export function startAutomaticChecks(): () => void {
  if (!desktop) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const run = async () => {
    try {
      await checkUpdates(true);
    } catch {
      // A failed automatic check stays quiet; the settings show the last result and retry.
    }
    if (!stopped) timer = setTimeout(() => void run(), daily);
  };
  void loadUpdates().catch(() => undefined);
  timer = setTimeout(() => void run(), firstCheck);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
