import { drawSurvivor, loadSurvivorAtlas } from '../../../src/features/games/survivor/renderer';
import { newSurvivor } from '../../../src/features/games/survivor/engine';
import { spawnEnemy } from '../../../src/features/games/survivor/enemies';
import { getTheme } from '../../../src/themes/registry';
import type { EnemyKind } from '../../../src/features/games/survivor/types';

const canvas = document.querySelector('canvas')!;
const atlas = loadSurvivorAtlas(() => window.survivorQuality.draw(1));
declare global {
  interface Window {
    survivorQuality: {
      ready: () => boolean;
      draw: (
        stage: number,
        dark?: boolean,
        dense?: boolean,
        reduced?: boolean,
      ) => Promise<{ immutable: boolean; pixels: string; p95: number }>;
    };
  }
}
window.survivorQuality = {
  ready: () => atlas.complete && atlas.naturalWidth > 0,
  async draw(stage, dark = false, dense = false, reduced = true) {
    const run = newSurvivor(42);
    run.stage.index = stage;
    run.tick = 150;
    const kinds: EnemyKind[] = [
      'slime',
      'bat',
      'mushroom',
      'golem',
      'boar',
      'giantSlime',
      'armoredBoar',
      'boss',
    ];
    for (let i = 0; i < (dense ? 180 : 8); i++) {
      const e = spawnEnemy(run, dense ? kinds[i % 5] : kinds[i]);
      if (!e) continue;
      e.x = 1600 - 380 + (i % (dense ? 18 : 4)) * (dense ? 44 : 240);
      e.y = 1600 - 150 + Math.floor(i / (dense ? 18 : 4)) * (dense ? 32 : 290);
    }
    const snapshot = JSON.stringify(run);
    const samples: number[] = [];
    for (let i = 0; i < (dense ? 120 : 1); i++) {
      if (dense) await new Promise(requestAnimationFrame);
      // Only the fixture advances animation time; rendering must leave all state intact.
      if (!reduced) run.tick = 150 + i;
      const before = performance.now();
      drawSurvivor(canvas, run, getTheme(dark ? 'github-dark' : undefined), atlas, reduced);
      samples.push(performance.now() - before);
    }
    run.tick = 150;
    samples.sort((a, b) => a - b);
    return {
      immutable: snapshot === JSON.stringify(run),
      pixels: canvas.toDataURL(),
      p95: samples[Math.floor(samples.length * 0.95)],
    };
  },
};
window.survivorQuality.draw(1);
