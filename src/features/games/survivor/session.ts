import { newSurvivor, pauseSurvivor } from './engine';
import { profileStartOptions } from './profile';
import { SurvivorProfileStore } from './profileStore';
import { finishSurvivor } from './stages';
import type { SurvivorRun } from './types';

/** G.8.5 calls sync after engine commands/frames and pause on blur; no RAF/React/IPC in this layer. */
export class SurvivorSession {
  run: SurvivorRun | null = null;
  runId: string | null = null;
  temporary = false;
  settled = false;
  private lastSaveAt = 0;
  private savedMarker = '';
  private failed = false;
  constructor(
    readonly profile: SurvivorProfileStore,
    private readonly now = () => performance.now(),
  ) {}
  start(seed: number, expectedRevision: number): boolean {
    if (this.run && !this.settled) return false;
    const state = this.profile.getSnapshot();
    if (state.mode !== 'owner' || state.profile.checkpoint) return false;
    const run = newSurvivor(seed, profileStartOptions(state.profile));
    const id = this.profile.begin(run, expectedRevision);
    if (!id) return false;
    this.run = run;
    this.runId = id;
    this.temporary = false;
    this.settled = false;
    this.failed = false;
    this.savedMarker = this.marker();
    this.lastSaveAt = this.now();
    return true;
  }
  startTemporary(seed: number): boolean {
    const state = this.profile.getSnapshot();
    if (
      (this.run && !this.settled) ||
      (!['temporary', 'blocked'].includes(state.mode) &&
        !(state.mode === 'owner' && state.error && !state.profile.checkpoint))
    )
      return false;
    this.run = newSurvivor(seed);
    this.runId = null;
    this.temporary = true;
    this.settled = false;
    this.failed = false;
    return true;
  }
  private marker(): string {
    const r = this.run!;
    return [
      r.phase,
      r.choice?.id ?? 0,
      r.stage.index,
      r.highestCompletedStage,
      r.bossesDefeated,
    ].join(':');
  }
  /** Failed saves pause combat and require an explicit retry, avoiding a write storm each frame. */
  sync(force = false): boolean {
    if (!this.run || this.settled) return true;
    if (this.temporary) {
      this.settled = this.run.phase === 'result';
      return true;
    }
    if (this.profile.getSnapshot().mode !== 'owner') {
      this.failed = true;
      pauseSurvivor(this.run);
      return false;
    }
    if (this.failed && !force) return false;
    const marker = this.marker();
    if (!force && marker === this.savedMarker && this.now() - this.lastSaveAt < 5000) return true;
    const ok =
      this.run.phase === 'result'
        ? this.profile.settle(this.runId!, this.run)
        : this.profile.checkpoint(this.runId!, this.run);
    this.failed = !ok;
    if (ok) {
      this.savedMarker = marker;
      this.lastSaveAt = this.now();
      this.settled = this.run.phase === 'result';
    } else pauseSurvivor(this.run);
    return ok;
  }
  pause(): boolean {
    if (!this.run) return true;
    pauseSurvivor(this.run);
    return this.sync(true);
  }
  finish(reason: 'retired' | 'abandoned', expectedStage?: number): boolean {
    if (!this.run) return true;
    if (this.run.phase !== 'result' && !finishSurvivor(this.run, reason, expectedStage))
      return false;
    return this.sync(true);
  }
  retrySave(): boolean {
    return this.sync(true);
  }
  /** Explicit tab close only. If persistence fails the caller must keep the tab/result open. */
  close(): boolean {
    if (!this.finish('abandoned')) return false;
    this.profile.dispose();
    return true;
  }
}
