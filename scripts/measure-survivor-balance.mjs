// Deterministic public-command simulation; does not certify human difficulty or fun.
import { build } from 'vite';
import vm from 'node:vm';
import { mkdir, writeFile } from 'node:fs/promises';
const bundle = await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    write: false,
    lib: { entry: 'tests/native/survivor-balance.ts', formats: ['iife'], name: 'Balance' },
  },
});
const code = (Array.isArray(bundle) ? bundle : [bundle])
  .flatMap((r) => r.output)
  .find((o) => o.type === 'chunk').code;
const context = vm.createContext({ console });
vm.runInContext(code, context);
const seeds = [1, 42, 2026, 11305, 71037];
const results = seeds.map((seed) => context.Balance.simulate(seed));
const longRuns = [1, 71037].map((seed) => context.Balance.simulate(seed, 31, 2700));
await mkdir('target/verification', { recursive: true });
await writeFile(
  'target/verification/survivor-balance.json',
  JSON.stringify(
    {
      method: 'test-only movement/card policy; no stat edits, no wall-clock UI play',
      results,
      longRuns,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    results.map(({ choices, stages, ...r }) => ({ ...r, cards: choices.length, stages })),
  ),
);
console.log(
  JSON.stringify({
    longRuns: longRuns.map(({ choices, stages, ...r }) => ({
      ...r,
      cards: choices.length,
      cleared: stages.length,
    })),
  }),
);
