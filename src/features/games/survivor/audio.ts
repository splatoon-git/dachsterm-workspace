import type { SurvivorRun } from './types';

type Cue = 'hit' | 'xp' | 'level' | 'evolution' | 'boss';
/** Bounded synthesis, no assets/network. A gesture is required before AudioContext creation. */
export class SurvivorAudio {
  private context: AudioContext | null = null;
  private voices = new Set<OscillatorNode>();
  private lastAt = -Infinity;
  private seen = '';
  private xp = 0;
  private level = 1;
  private kills = 0;
  private evolutions = 0;
  private damage = -1;
  private stage = '';
  private hits = new Map<string, number>();
  reset() {
    this.stop();
    this.seen = '';
    this.xp = 0;
    this.level = 1;
    this.kills = 0;
    this.evolutions = 0;
    this.damage = -1;
    this.stage = '';
    this.hits.clear();
    this.lastAt = -Infinity;
  }
  unlock(muted: boolean) {
    if (muted || typeof AudioContext === 'undefined') return;
    try {
      this.context ??= new AudioContext();
      void this.context.resume().catch(() => {});
    } catch {
      /* Optional on restricted WebViews. */
    }
  }
  observe(run: SurvivorRun, enabled: boolean) {
    const evolved = run.weapons.filter((w) => w.evolved).length;
    const stage = `${run.stage.index}:${run.stage.phase}`;
    const mark = `${run.tick}:${run.phase}:${evolved}`;
    if (this.seen === mark) return;
    let cue: Cue | null = null;
    if (run.xp > this.xp) cue = 'xp';
    const hits = new Map<string, number>();
    for (const attack of run.attacks) hits.set(`a${attack.id}`, attack.hitIds.length);
    if (run.bite.lastAttack)
      hits.set(`b${run.bite.lastAttack.id}`, run.bite.lastAttack.hitIds.length);
    for (const [id, count] of hits) if (count > (this.hits.get(id) ?? 0)) cue = 'hit';
    this.hits = hits;
    if (run.kills > this.kills || (run.lastDamage && run.lastDamage.tick !== this.damage))
      cue = 'hit';
    if (run.level > this.level) cue = 'level';
    if (evolved > this.evolutions) cue = 'evolution';
    if (stage !== this.stage && run.stage.phase === 'bossWarning') cue = 'boss';
    this.seen = mark;
    this.xp = run.xp;
    this.level = run.level;
    this.kills = run.kills;
    this.evolutions = evolved;
    this.damage = run.lastDamage?.tick ?? -1;
    this.stage = stage;
    if (enabled && cue) this.play(cue);
  }
  private play(cue: Cue) {
    const ctx = this.context;
    if (
      !ctx ||
      ctx.state !== 'running' ||
      this.voices.size >= 3 ||
      ctx.currentTime - this.lastAt < 0.08
    )
      return;
    this.lastAt = ctx.currentTime;
    const oscillator = ctx.createOscillator(),
      gain = ctx.createGain();
    const [from, to, duration] = {
      hit: [180, 65, 0.09],
      xp: [650, 900, 0.07],
      level: [320, 720, 0.22],
      evolution: [420, 1100, 0.3],
      boss: [150, 80, 0.3],
    }[cue];
    oscillator.type = cue === 'hit' ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(from, ctx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(to, ctx.currentTime + duration);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    this.voices.add(oscillator);
    oscillator.onended = () => {
      this.voices.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start();
    oscillator.stop(ctx.currentTime + duration);
  }
  stop() {
    for (const voice of this.voices) {
      try {
        voice.stop();
      } catch {
        /* Already ended. */
      }
    }
    this.voices.clear();
    if (this.context?.state === 'running') void this.context.suspend().catch(() => {});
  }
  dispose() {
    this.stop();
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}
