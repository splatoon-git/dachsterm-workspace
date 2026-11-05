import {
  PROFILE_KEY,
  checkpointAdvances,
  checkpointFor,
  isSurvivorProfile,
  newSurvivorProfile,
  parseSurvivorProfile,
  purchaseProfile,
  refundProfile,
  settleProfile,
  type Purchase,
  type SurvivorProfile,
} from './profile';
import type { SurvivorRun } from './types';

export type ProfileMode = 'loading' | 'owner' | 'readonly' | 'temporary' | 'blocked' | 'closed';
export type ProfileSnapshot = { mode: ProfileMode; profile: SurvivorProfile; error: string | null };
export type ProfileEnvironment = {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  /** Resolves once acquisition is known; the release callback holds the lock until called. */
  acquire: (() => Promise<(() => void) | null>) | null;
  subscribe: (notify: () => void) => () => void;
  now: () => number;
  uuid: () => string;
};
const SAVE_ERROR =
  '저장하지 못했습니다. 변경을 적용하지 않았습니다. 저장 재시도로 다시 시도해 주세요.';

export function browserProfileEnvironment(): ProfileEnvironment {
  return {
    // Resolve localStorage lazily: even reading the property may throw in restricted webviews.
    storage: {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    },
    acquire:
      typeof navigator !== 'undefined' && navigator.locks?.request
        ? () =>
            new Promise((resolve, reject) => {
              void navigator.locks
                .request(PROFILE_KEY, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
                  if (!lock) {
                    resolve(null);
                    return;
                  }
                  await new Promise<void>((release) => resolve(release));
                })
                .catch(reject);
            })
        : null,
    subscribe: (notify) => {
      const listener = (e: StorageEvent) => {
        if (e.key === PROFILE_KEY || e.key === null) notify();
      };
      window.addEventListener('storage', listener);
      return () => window.removeEventListener('storage', listener);
    },
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
  };
}

/** One store per game tab, not per React render. dispose releases ownership, never settles a run. */
export class SurvivorProfileStore {
  private state: ProfileSnapshot = { mode: 'loading', profile: newSurvivorProfile(), error: null };
  private raw: string | null = null;
  private release: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private connecting = false;
  private closed = false;
  private recoveryPending = false;
  constructor(private readonly env: ProfileEnvironment = browserProfileEnvironment()) {}
  getSnapshot = (): ProfileSnapshot => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<ProfileSnapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private load(): boolean {
    try {
      const raw = this.env.storage.getItem(PROFILE_KEY);
      const result = parseSurvivorProfile(raw);
      if (!result.ok) {
        this.publish({
          mode: 'blocked',
          error:
            result.error === 'future'
              ? '더 새로운 버전의 저장 데이터입니다. 기존 저장은 보존되며 임시 플레이만 가능합니다.'
              : '저장 데이터가 손상되어 변경할 수 없습니다. 기존 저장은 보존되며 임시 플레이만 가능합니다.',
        });
        return false;
      }
      this.raw = raw;
      this.publish({ profile: result.profile, error: null });
      return true;
    } catch {
      this.publish({
        mode: 'temporary',
        error: '저장소에 접근할 수 없습니다. 임시 플레이의 보상과 기록은 저장되지 않습니다.',
      });
      return false;
    }
  }
  async connect(): Promise<void> {
    if (this.closed || this.connecting || this.release) return;
    this.connecting = true;
    this.publish({ mode: 'loading', error: null });
    this.unsubscribe ??= this.env.subscribe(() => {
      if (this.release) {
        // A non-cooperating writer (or storage reset) must not be overwritten by a stale owner.
        try {
          if (this.env.storage.getItem(PROFILE_KEY) === this.raw) return;
        } catch {
          /* fail closed */
        }
        this.publish({
          mode: 'blocked',
          error: '다른 곳에서 저장이 변경되었습니다. 현재 결과를 유지하고 쉼터를 다시 열어 주세요.',
        });
      } else this.load();
    });
    try {
      if (!this.env.acquire) {
        this.load();
        if (this.state.mode !== 'blocked')
          this.publish({
            mode: 'temporary',
            error:
              '이 환경은 저장 소유권을 지원하지 않습니다. 임시 플레이의 보상과 기록은 저장되지 않습니다.',
          });
        return;
      }
      const release = await this.env.acquire();
      if (this.closed) {
        release?.();
        return;
      }
      this.release = release;
      if (!this.load()) return;
      this.publish({ mode: release ? 'owner' : 'readonly', error: null });
      if (release) {
        this.recoveryPending = !!this.state.profile.checkpoint;
        this.recover();
      }
    } catch {
      if (!this.closed)
        this.publish({
          mode: 'temporary',
          error:
            '저장 소유권을 확보하지 못했습니다. 임시 플레이의 보상과 기록은 저장되지 않습니다.',
        });
    } finally {
      this.connecting = false;
    }
  }
  private commit(
    next: SurvivorProfile | null,
    expectedRevision = this.state.profile.revision,
  ): boolean {
    if (
      !next ||
      this.closed ||
      !this.release ||
      this.state.mode !== 'owner' ||
      expectedRevision !== this.state.profile.revision
    )
      return false;
    next.revision = this.state.profile.revision + 1;
    if (!isSurvivorProfile(next)) {
      this.publish({ error: '유효하지 않은 변경입니다. 기존 저장을 유지합니다.' });
      return false;
    }
    try {
      if (this.env.storage.getItem(PROFILE_KEY) !== this.raw) {
        this.publish({
          mode: 'blocked',
          error: '다른 곳에서 저장이 변경되어 덮어쓰기를 중단했습니다.',
        });
        return false;
      }
      const raw = JSON.stringify(next);
      // localStorage.setItem is the one atomic record replacement. No preceding debit/checkpoint write.
      this.env.storage.setItem(PROFILE_KEY, raw);
      this.raw = raw;
      this.publish({ profile: next, error: null });
      return true;
    } catch {
      this.publish({ error: SAVE_ERROR });
      return false;
    }
  }
  purchase(item: Purchase, expectedRevision: number): boolean {
    return this.commit(purchaseProfile(this.state.profile, item), expectedRevision);
  }
  refund(expectedRevision: number): boolean {
    return this.commit(refundProfile(this.state.profile), expectedRevision);
  }
  settings(settings: SurvivorProfile['settings'], expectedRevision: number): boolean {
    return this.commit({ ...this.state.profile, settings: { ...settings } }, expectedRevision);
  }
  begin(run: SurvivorRun, expectedRevision: number): string | null {
    if (
      this.state.profile.checkpoint ||
      run.tick !== 0 ||
      run.gold !== 0 ||
      run.bossesDefeated !== 0 ||
      run.phase !== 'playing'
    )
      return null;
    let runId: string;
    try {
      runId = this.env.uuid();
    } catch {
      this.publish({ error: SAVE_ERROR });
      return null;
    }
    const cp = checkpointFor(runId, run, this.env.now());
    return this.commit({ ...this.state.profile, checkpoint: cp }, expectedRevision) ? runId : null;
  }
  checkpoint(runId: string, run: SurvivorRun): boolean {
    const before = this.state.profile.checkpoint;
    const cp = checkpointFor(runId, run, Math.max(this.env.now(), before?.savedAt ?? 0));
    if (!before || !checkpointAdvances(before, cp)) return false;
    return this.commit({ ...this.state.profile, checkpoint: cp });
  }
  settle(runId: string, run: SurvivorRun): boolean {
    if (run.phase !== 'result' || !run.result) return false;
    const cp = checkpointFor(
      runId,
      run,
      Math.max(this.env.now(), this.state.profile.checkpoint?.savedAt ?? 0),
    );
    return this.commit(settleProfile(this.state.profile, cp, run.result));
  }
  /** Only call on a newly acquired owner, or retry its failed recovery before starting a new run. */
  recover(): boolean {
    const cp = this.state.profile.checkpoint;
    if (!cp) return true;
    if (!this.recoveryPending) return false;
    const ok = this.commit(settleProfile(this.state.profile, cp, 'interrupted'));
    if (ok) this.recoveryPending = false;
    return ok;
  }
  dispose(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.release?.();
    this.release = null;
    this.publish({ mode: 'closed' });
    this.listeners.clear();
  }
}
