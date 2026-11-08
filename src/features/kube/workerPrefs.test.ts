import { describe, expect, it } from 'vitest';
import {
  defaultWorkerPrefs,
  parseWorkerPrefs,
  withConsent,
  withPinToggled,
  withWatch,
  withoutWatch,
} from './workerPrefs';
import type { WorkerWatch } from './workers';

const watch: WorkerWatch = {
  key: 'web/Deployment/api',
  namespace: 'web',
  kind: 'Deployment',
  name: 'api',
  minutes: 5,
  metrics: {
    port: 8080,
    path: '/metrics',
    https: false,
    roles: { busy: 'a', total: 'b', completed: 'c' },
  },
  probe: { container: 'app' },
};

describe('worker prefs', () => {
  it('reads back what it wrote', () => {
    const prefs = { watches: [watch], pins: { k: ['a{x="y"}'] }, consent: ['k'] };
    expect(parseWorkerPrefs(JSON.stringify(prefs))).toEqual(prefs);
  });

  it('starts empty from nothing or from damage', () => {
    expect(parseWorkerPrefs(null)).toEqual(defaultWorkerPrefs());
    expect(parseWorkerPrefs('{broken')).toEqual(defaultWorkerPrefs());
    expect(parseWorkerPrefs('[1]')).toEqual(defaultWorkerPrefs());
    expect(parseWorkerPrefs('null')).toEqual(defaultWorkerPrefs());
  });

  it('drops only the entry that is damaged', () => {
    const bad = [
      { ...watch, minutes: 0 },
      { ...watch, minutes: 5.5 },
      { ...watch, key: '' },
      { ...watch, metrics: { ...watch.metrics, port: 70000 } },
      { ...watch, metrics: { ...watch.metrics, roles: { busy: 'a' } } },
      { ...watch, probe: { container: 7 } },
      { ...watch, metrics: null, probe: null },
      'nonsense',
      null,
    ];
    const prefs = parseWorkerPrefs(
      JSON.stringify({ watches: [...bad, watch], pins: 3, consent: {} }),
    );
    expect(prefs.watches).toEqual([watch]);
    expect(prefs.pins).toEqual({});
    expect(prefs.consent).toEqual([]);
  });

  it('accepts a workload watched one way only', () => {
    const onlyProbe = { ...watch, metrics: null };
    const onlyMetrics = { ...watch, probe: null };
    expect(parseWorkerPrefs(JSON.stringify({ watches: [onlyProbe] })).watches).toEqual([onlyProbe]);
    expect(parseWorkerPrefs(JSON.stringify({ watches: [onlyMetrics] })).watches).toEqual([
      onlyMetrics,
    ]);
  });

  it('replaces a watch rather than listing it twice', () => {
    const once = withWatch(defaultWorkerPrefs(), watch);
    const twice = withWatch(once, { ...watch, minutes: 9 });
    expect(twice.watches).toHaveLength(1);
    expect(twice.watches[0].minutes).toBe(9);
    expect(withoutWatch(twice, watch.key).watches).toEqual([]);
  });

  it('remembers a probe consent once', () => {
    const prefs = withConsent(withConsent(defaultWorkerPrefs(), 'k'), 'k');
    expect(prefs.consent).toEqual(['k']);
  });

  it('toggles a pin', () => {
    const on = withPinToggled(defaultWorkerPrefs(), 'k', 'm');
    expect(on.pins.k).toEqual(['m']);
    expect(withPinToggled(on, 'k', 'm').pins.k).toEqual([]);
  });
});
