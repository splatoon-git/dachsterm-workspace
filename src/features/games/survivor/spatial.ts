import type { SurvivorEnemy } from './types';

/** Rebuilt after movement; queries return candidates, callers do exact geometry. */
export class EnemyGrid {
  private readonly cells = new Map<string, SurvivorEnemy[]>();
  private readonly spare: SurvivorEnemy[][] = [];
  private readonly size = 128;

  rebuild(enemies: readonly SurvivorEnemy[]) {
    for (const bucket of this.cells.values()) {
      bucket.length = 0;
      this.spare.push(bucket);
    }
    this.cells.clear();
    for (const enemy of enemies) {
      const key = `${Math.floor(enemy.x / this.size)},${Math.floor(enemy.y / this.size)}`;
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = this.spare.pop() ?? [];
        this.cells.set(key, bucket);
      }
      bucket.push(enemy);
    }
  }

  visit(x: number, y: number, radius: number, callback: (enemy: SurvivorEnemy) => void) {
    for (
      let cy = Math.floor((y - radius) / this.size);
      cy <= Math.floor((y + radius) / this.size);
      cy++
    )
      for (
        let cx = Math.floor((x - radius) / this.size);
        cx <= Math.floor((x + radius) / this.size);
        cx++
      ) {
        const bucket = this.cells.get(`${cx},${cy}`);
        if (bucket) for (const enemy of bucket) callback(enemy);
      }
  }
}
