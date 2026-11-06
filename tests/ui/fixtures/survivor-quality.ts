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
      checkMovingTerrain: () => { returnsToScene: boolean; stableOnHit: boolean };
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
  checkMovingTerrain() {
    const run = newSurvivor(42);
    const draw = () => drawSurvivor(canvas, run, getTheme(), atlas, false);
    // This strip contains only terrain, outside the player and hit readout.
    const terrain = () => canvas.getContext('2d')!.getImageData(0, 0, canvas.width, 70).data;
    draw();
    const start = canvas.toDataURL();
    for (const x of [1610.25, 1968.5, 2830.75, 1600]) {
      run.player.x = x;
      draw();
    }
    const returnsToScene = canvas.toDataURL() === start;
    const before = terrain();
    run.tick = 5;
    run.lastDamage = { tick: 4, amount: 7 };
    draw();
    const after = terrain();
    return { returnsToScene, stableOnHit: before.every((value, i) => value === after[i]) };
  },
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
