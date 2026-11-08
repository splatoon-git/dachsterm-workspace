import { MAX_MINUTES, MIN_MINUTES, type MetricRoles, type WorkerWatch } from './workers';

const MAX_WATCHES = 32;
const MAX_PIN_KEYS = 64;
const MAX_PINS = 64;
const MAX_CONSENT = 200;
const storageKey = (session: string) => `dachsterm.kube.workers.${session}`;

export type WorkerPrefs = {
  watches: WorkerWatch[];
  /** Metrics the user pinned to the top of the list, by workload. */
  pins: Record<string, string[]>;
  /** Workloads whose probe the user has already allowed once (design KV.9). */
  consent: string[];
};

export const defaultWorkerPrefs = (): WorkerPrefs => ({ watches: [], pins: {}, consent: [] });

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function parseRoles(value: unknown): MetricRoles | null {
  const roles = value as Partial<MetricRoles> | null;
  return roles && isText(roles.busy) && isText(roles.total) && isText(roles.completed)
    ? { busy: roles.busy, total: roles.total, completed: roles.completed }
    : null;
}

function parseMetrics(value: unknown): WorkerWatch['metrics'] | undefined {
  if (value === null) return null;
  const metrics = value as Partial<NonNullable<WorkerWatch['metrics']>> | null;
  if (!metrics) return undefined;
  const roles = parseRoles(metrics.roles);
  const validPort = Number.isInteger(metrics.port) && metrics.port! >= 1 && metrics.port! <= 65535;
  if (!roles || !validPort || !isText(metrics.path) || typeof metrics.https !== 'boolean')
    return undefined;
  return { port: metrics.port!, path: metrics.path, https: metrics.https, roles };
}

function parseWatch(value: unknown): WorkerWatch | null {
  const watch = value as Partial<WorkerWatch> | null;
  if (!watch || !isText(watch.key) || !isText(watch.namespace)) return null;
  if (!isText(watch.kind) || !isText(watch.name)) return null;
  const validMinutes =
    Number.isInteger(watch.minutes) &&
    watch.minutes! >= MIN_MINUTES &&
    watch.minutes! <= MAX_MINUTES;
  const metrics = parseMetrics(watch.metrics);
  const probe = watch.probe as { container?: unknown } | null | undefined;
  const validProbe = probe === null || isText(probe?.container);
  if (!validMinutes || metrics === undefined || !validProbe || (!metrics && !probe)) return null;
  return {
    key: watch.key,
    namespace: watch.namespace,
    kind: watch.kind,
    name: watch.name,
    minutes: watch.minutes!,
    metrics,
    probe: probe ? { container: probe.container as string } : null,
  };
}

const textList = (value: unknown, limit: number) =>
  Array.isArray(value) ? value.filter(isText).slice(0, limit) : [];

/** A damaged entry is dropped on its own; it must not cost the user every other watch. */
export function parseWorkerPrefs(text: string | null): WorkerPrefs {
  if (!text) return defaultWorkerPrefs();
  try {
    const value = JSON.parse(text) as Partial<WorkerPrefs> | null;
    if (!value || typeof value !== 'object') return defaultWorkerPrefs();
    const watches = (Array.isArray(value.watches) ? value.watches : [])
      .map(parseWatch)
      .filter((watch): watch is WorkerWatch => watch !== null)
      .slice(0, MAX_WATCHES);
    const pins =
      typeof value.pins === 'object' && value.pins !== null && !Array.isArray(value.pins)
        ? Object.fromEntries(
            Object.entries(value.pins)
              .slice(0, MAX_PIN_KEYS)
              .map(([key, list]) => [key, textList(list, MAX_PINS)]),
          )
        : {};
    return { watches, pins, consent: textList(value.consent, MAX_CONSENT) };
  } catch {
    return defaultWorkerPrefs();
  }
}

/** A session with no saved profile has no id to file this under, so it lasts as long as the tab. */
export function readWorkerPrefs(session: string): WorkerPrefs {
  if (!session) return defaultWorkerPrefs();
  try {
    return parseWorkerPrefs(localStorage.getItem(storageKey(session)));
  } catch {
    return defaultWorkerPrefs();
  }
}

export function writeWorkerPrefs(session: string, prefs: WorkerPrefs) {
  if (!session) return;
  try {
    localStorage.setItem(storageKey(session), JSON.stringify(prefs));
  } catch {
    // Watching still works for this tab; only the memory of it across restarts is lost.
  }
}

export const withConsent = (prefs: WorkerPrefs, key: string): WorkerPrefs =>
  prefs.consent.includes(key)
    ? prefs
    : { ...prefs, consent: [...prefs.consent, key].slice(-MAX_CONSENT) };

export function withWatch(prefs: WorkerPrefs, watch: WorkerWatch): WorkerPrefs {
  const others = prefs.watches.filter((item) => item.key !== watch.key);
  return { ...prefs, watches: [...others, watch].slice(-MAX_WATCHES) };
}

export const withoutWatch = (prefs: WorkerPrefs, key: string): WorkerPrefs => ({
  ...prefs,
  watches: prefs.watches.filter((item) => item.key !== key),
});

export function withPinToggled(prefs: WorkerPrefs, key: string, selector: string): WorkerPrefs {
  const current = prefs.pins[key] ?? [];
  const next = current.includes(selector)
    ? current.filter((item) => item !== selector)
    : [...current, selector].slice(-MAX_PINS);
  return { ...prefs, pins: { ...prefs.pins, [key]: next } };
}
