import { resumeSurvivor, stepSurvivor } from './engine';
import { chooseSurvivorCard, rerollSurvivorCards } from './progression';
import { SurvivorProfileStore } from './profileStore';
import { SurvivorSession } from './session';
import { continueSurvivorStage } from './stages';
import type { SurvivorInput } from './types';

/** One lifetime per mounted tab. React snapshots contain only a revision, never entity copies. */
export class SurvivorController {
  readonly session: SurvivorSession;
  private revision = 0;
  private listeners = new Set<() => void>();
  private lastHud = 0;
  private mounts = 0;
  private generation = 0;
  saveFailed = false;
  inHub = true;
  constructor(readonly store = new SurvivorProfileStore()) {
    this.session = new SurvivorSession(store);
  }
  getSnapshot = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  publish = () => {
    this.revision++;
    for (const listener of this.listeners) listener();
  };
  mount() {
    this.mounts++;
    this.generation++;
    void this.store.connect();
    return () => {
      this.mounts--;
      const generation = ++this.generation;
      // StrictMode setup/cleanup/setup must retain the same lock and run.
      queueMicrotask(() => {
        if (!this.mounts && generation === this.generation) this.store.dispose();
      });
    };
  }
  start(revision: number, temporary = false) {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const ok = temporary ? this.session.startTemporary(seed) : this.session.start(seed, revision);
    if (ok) {
      this.inHub = false;
      this.saveFailed = false;
    }
    this.publish();
    return ok;
  }
  private sync() {
    this.saveFailed = !this.session.sync();
    this.publish();
  }
  frame(dt: number, now: number, input: SurvivorInput) {
    const run = this.session.run;
    if (!run || this.inHub) return;
    const before = `${run.phase}:${run.level}:${run.player.hp}:${run.stage.phase}`;
    stepSurvivor(run, dt, input);
    this.saveFailed = !this.session.sync();
    if (
      now - this.lastHud >= 100 ||
      before !== `${run.phase}:${run.level}:${run.player.hp}:${run.stage.phase}` ||
      this.saveFailed
    ) {
      this.lastHud = now;
      this.publish();
    }
  }
  pause = () => {
    if (this.inHub || !this.session.run || this.session.settled) return;
    this.saveFailed = !this.session.pause();
    this.publish();
  };
  resume = () => {
    if (this.saveFailed || !this.session.run) return;
    resumeSurvivor(this.session.run);
    this.sync();
  };
  choose(choiceId: number, cardId: string) {
    if (
      !this.saveFailed &&
      this.session.run &&
      chooseSurvivorCard(this.session.run, choiceId, cardId)
    )
      this.sync();
  }
  reroll(choiceId: number) {
    if (!this.saveFailed && this.session.run && rerollSurvivorCards(this.session.run, choiceId))
      this.sync();
  }
  next(stage: number) {
    if (!this.saveFailed && this.session.run && continueSurvivorStage(this.session.run, stage))
      this.sync();
  }
  finish(reason: 'retired' | 'abandoned', stage?: number) {
    this.saveFailed = !this.session.finish(reason, stage);
    this.publish();
  }
  retry = () => {
    this.saveFailed = !this.session.retrySave();
    this.publish();
  };
  hub = () => {
    if (!this.session.settled) return;
    this.inHub = true;
    this.publish();
  };
  close = () => {
    const ok = this.session.close();
    this.saveFailed = !ok;
    this.publish();
    return ok;
  };
}
