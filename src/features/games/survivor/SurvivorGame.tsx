import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { useTheme } from '../../../themes/useTheme';
import { ABILITIES, EVOLUTIONS, MAX_LEVEL, WEAPONS, xpToNextLevel } from './content';
import { SurvivorAudio } from './audio';
import { SurvivorController } from './controller';
import { drawSurvivor, loadSurvivorAtlas } from './renderer';
import { SurvivorHub } from './SurvivorHub';
import './survivor.css';

const movement: Record<string, [number, number]> = {
  w: [0, -1],
  ArrowUp: [0, -1],
  s: [0, 1],
  ArrowDown: [0, 1],
  a: [-1, 0],
  ArrowLeft: [-1, 0],
  d: [1, 0],
  ArrowRight: [1, 0],
};
const pads = [
  [-1, -1, '↖'],
  [0, -1, '↑'],
  [1, -1, '↗'],
  [-1, 0, '←'],
  [0, 0, 'P'],
  [1, 0, '→'],
  [-1, 1, '↙'],
  [0, 1, '↓'],
  [1, 1, '↘'],
] as const;
const time = (ticks: number) =>
  `${Math.floor(ticks / 3600)}:${String(Math.floor(ticks / 60) % 60).padStart(2, '0')}`;
const subscribeMotion = (fn: () => void) => {
  const query = matchMedia('(prefers-reduced-motion: reduce)');
  query.addEventListener('change', fn);
  return () => query.removeEventListener('change', fn);
};
export type SurvivorCloseRegistration = (close: (() => boolean) | null) => void;

export function SurvivorGame({
  active,
  registerClose,
  controller: provided,
}: {
  active: boolean;
  registerClose?: SurvivorCloseRegistration;
  controller?: SurvivorController;
}) {
  const [controller] = useState(() => provided ?? new SurvivorController());
  const revision = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const profile = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const [audio] = useState(() => new SurvivorAudio());
  const [input] = useState(() => ({
    held: new Set<string>(),
    keys: new Set<string>(),
    pointers: new Map<number, readonly [number, number]>(),
  }));
  const [temporaryMuted, setTemporaryMuted] = useState(true);
  const theme = useTheme();
  const systemReduced = useSyncExternalStore(
    subscribeMotion,
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const reduced =
    profile.profile.settings.motion === 'reduced' ||
    (profile.profile.settings.motion === 'system' && systemReduced);
  const muted = controller.session.temporary ? temporaryMuted : profile.profile.settings.muted;
  const root = useRef<HTMLElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const previousActive = useRef(active);
  const atlasRef = useRef<HTMLImageElement | null>(null);
  const run = controller.inHub ? null : controller.session.run;
  const phase = run?.phase ?? 'hub',
    choiceId = run?.choice?.id;
  const choice = run?.choice,
    stageIndex = run?.stage.index ?? 1;
  const clearMovement = () => {
    input.keys.clear();
    input.pointers.clear();
  };
  const gesture = () => audio.unlock(muted);

  useEffect(() => controller.mount(), [controller]);
  useEffect(() => {
    registerClose?.(controller.close);
    return () => registerClose?.(null);
  }, [controller, registerClose]);
  useEffect(() => {
    const pause = () => {
      input.keys.clear();
      input.pointers.clear();
      input.held.clear();
      audio.stop();
      controller.pause();
    };
    const visibility = () => {
      if (document.hidden) pause();
    };
    const up = (e: globalThis.KeyboardEvent) => {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      input.keys.delete(key);
      input.held.delete(key);
    };
    const release = (e: PointerEvent) => input.pointers.delete(e.pointerId);
    window.addEventListener('blur', pause);
    window.addEventListener('pagehide', pause);
    document.addEventListener('freeze', pause);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('keyup', up);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('blur', pause);
      window.removeEventListener('pagehide', pause);
      document.removeEventListener('freeze', pause);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('keyup', up);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      audio.dispose();
    };
  }, [controller, audio, input]);
  useEffect(() => {
    if (!active) {
      input.keys.clear();
      input.pointers.clear();
      input.held.clear();
      audio.stop();
      controller.pause();
    }
  }, [active, controller, input, audio]);
  useLayoutEffect(() => {
    const reentered = active && !previousActive.current;
    previousActive.current = active;
    if (phase !== 'playing') {
      input.keys.clear();
      input.pointers.clear();
    }
    if (!active) return;
    if (phase === 'paused' && !reentered && !root.current?.contains(document.activeElement)) return;
    if (phase === 'playing') canvas.current?.focus({ preventScroll: true });
    else if (phase === 'hub')
      root.current
        ?.querySelector<HTMLElement>('.survivor-hub button:not(:disabled)')
        ?.focus({ preventScroll: true });
    else
      panel.current
        ?.querySelector<HTMLElement>('button:not(:disabled)')
        ?.focus({ preventScroll: true });
  }, [phase, choiceId, active, input, profile.mode]);
  useEffect(() => {
    if (!active || phase === 'hub') return;
    const field = canvas.current,
      current = controller.session.run;
    if (!field || !current) return;
    let frame = 0,
      last = performance.now(),
      stopped = false;
    const draw = () => {
      if (!stopped) drawSurvivor(field, current, theme, atlas, reduced);
    };
    const atlas = (atlasRef.current ??= loadSurvivorAtlas(draw));
    atlas.onload = draw;
    const resize = new ResizeObserver(draw);
    resize.observe(field);
    const tick = (now: number) => {
      // Suspend/resume and a stalled WebView can omit blur/visibility events.
      // Pause before advancing any catch-up ticks and discard all held input.
      if (
        now - last >= 1000 ||
        document.hidden ||
        !root.current?.contains(document.activeElement)
      ) {
        input.keys.clear();
        input.pointers.clear();
        input.held.clear();
        controller.pause();
        audio.stop();
        return;
      }
      let x = 0,
        y = 0;
      for (const key of input.keys) {
        x += movement[key]?.[0] ?? 0;
        y += movement[key]?.[1] ?? 0;
      }
      for (const vector of input.pointers.values()) {
        x += vector[0];
        y += vector[1];
      }
      controller.frame((now - last) / 1000, now, {
        moveX: Math.max(-1, Math.min(1, x)),
        moveY: Math.max(-1, Math.min(1, y)),
      });
      last = now;
      audio.observe(current, !muted);
      draw();
      if (current.phase === 'playing') frame = requestAnimationFrame(tick);
    };
    draw();
    if (phase === 'playing') frame = requestAnimationFrame(tick);
    else if (phase !== 'choosing') audio.stop();
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      atlas.onload = null;
    };
  }, [active, phase, controller, input, audio, muted, theme, reduced]);
  // Rerolls and paused theme changes do not start the simulation.
  useEffect(() => {
    if (muted) audio.stop();
  }, [muted, audio]);

  const toggleMute = () => {
    if (controller.session.temporary) {
      setTemporaryMuted(!muted);
      if (muted) audio.unlock(false);
      else audio.stop();
      return;
    }
    const p = controller.store.getSnapshot().profile;
    if (controller.store.settings({ ...p.settings, muted: !muted }, p.revision)) {
      if (muted) audio.unlock(false);
      else audio.stop();
    } else controller.pause();
  };
  const choose = (id: string) => {
    if (choice && run) {
      gesture();
      controller.choose(choice.id, id);
      audio.observe(run, !muted);
    }
  };
  const resume = () => {
    gesture();
    controller.resume();
  };
  const start = (rev: number, temporary = false) => {
    if (controller.start(rev, temporary)) {
      audio.reset();
      gesture();
    }
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (
      !active ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      e.nativeEvent.isComposing ||
      (e.target instanceof HTMLElement &&
        (e.target.matches('input,select,textarea') || e.target.isContentEditable))
    )
      return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'Escape') {
      clearMovement();
      audio.stop();
      controller.pause();
      return;
    }
    const action = ['Enter', ' ', '1', '2', '3', 'r', 'p', 'm'].includes(key);
    if (!movement[key] && !action) return;
    e.preventDefault();
    e.stopPropagation();
    const held = input.held.has(key);
    input.held.add(key);
    if (e.repeat || held) return;
    gesture();
    if (key === 'm') {
      toggleMute();
      return;
    }
    if (key === 'p' && run) {
      if (phase === 'paused') resume();
      else controller.pause();
      return;
    }
    if (phase === 'choosing' && run?.choice) {
      if (key === 'r') controller.reroll(run.choice.id);
      if (/^[123]$/.test(key)) {
        const card = run.choice.cards[Number(key) - 1];
        if (card) choose(card.id);
      }
      if (movement[key]) {
        const cards = Array.from(
          panel.current?.querySelectorAll<HTMLButtonElement>('.survivor-card') ?? [],
        );
        const at = cards.indexOf(document.activeElement as HTMLButtonElement);
        cards[
          (at + (movement[key][0] + movement[key][1] > 0 ? 1 : -1) + cards.length) % cards.length
        ]?.focus();
      }
    } else if (phase === 'playing' && movement[key]) input.keys.add(key);
    if (key === 'Enter' || key === ' ') {
      if (e.target instanceof HTMLButtonElement) e.target.click();
      else if (phase === 'paused') resume();
      else if (phase === 'stageClear' && run) controller.next(stageIndex);
    }
  };
  const settlement = profile.profile.settlements.find((s) => s.runId === controller.session.runId);
  const firstBossGold =
    settlement?.firstBossGold ??
    (run?.bossesDefeated && !profile.profile.firstBossRewarded ? 30 : 0);
  const boss = run?.enemies.find((e) => e.kind === 'boss');
  const weapons =
    run?.weapons.map(
      (w) =>
        `${w.evolved ? Object.values(EVOLUTIONS).find((e) => e.weapon === w.id)?.name : WEAPONS[w.id].name} ${w.rank}${w.evolved ? ' · 진화' : ''}`,
    ) ?? [];
  const abilities = run?.abilities.map((a) => `${ABILITIES[a.id].name} ${a.rank}`) ?? [];
  return (
    <section
      ref={root}
      className="survivor-game"
      aria-label="닥스의 서바이버"
      data-phase={phase}
      data-revision={revision}
      data-motion={reduced ? 'reduced' : 'full'}
      onKeyDownCapture={onKey}
      onKeyUpCapture={(e) => {
        if (
          (e.key === ' ' || e.key === 'Enter') &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          e.target instanceof HTMLButtonElement
        )
          e.preventDefault();
      }}
      onClickCapture={(e) => {
        if (e.detail > 1 && (e.target as HTMLElement).closest('button')) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          clearMovement();
          audio.stop();
          controller.pause();
        }
      }}
    >
      {!run ? (
        <>
          <p className="survivor-intro">
            숲에서 살아남고, 나만의 조합을 키워 보세요. WASD·방향키로 이동하면 자동으로 공격합니다.
            ◆ 경험치를 모아 카드로 성장하고, 60초마다 다음 스테이지에 도전하세요. 3의 배수 구간에는
            보스가 기다립니다.
          </p>
          <SurvivorHub
            store={controller.store}
            onStart={(rev) => start(rev)}
            onTemporaryStart={() => start(0, true)}
          />
        </>
      ) : (
        <>
          <div className="survivor-hud" aria-label="전투 정보">
            <div>
              <strong>스테이지 {run.stage.index}</strong>
              <span>
                {run.stage.phase === 'wave'
                  ? `남은 시간 ${Math.max(0, Math.ceil((3600 - run.stage.waveTicks) / 60))}초`
                  : run.stage.phase === 'bossWarning'
                    ? '보스 등장 예고'
                    : `보스전 ${time(run.stage.bossTicks)}`}
              </span>
            </div>
            <div>
              <label htmlFor="survivor-hp">
                HP {Math.ceil(run.player.hp)} / {run.player.stats.maxHp}
              </label>
              <progress id="survivor-hp" max={run.player.stats.maxHp} value={run.player.hp} />
            </div>
            <div>
              <label htmlFor="survivor-xp">
                레벨 {run.level} ·{' '}
                {run.level === MAX_LEVEL
                  ? 'MAX'
                  : `XP ${Math.floor(run.xp)} / ${xpToNextLevel(run.level)}`}
              </label>
              <progress
                id="survivor-xp"
                max={run.level === MAX_LEVEL ? 1 : xpToNextLevel(run.level)}
                value={run.level === MAX_LEVEL ? 1 : run.xp}
              />
            </div>
            <div>
              <span>
                이번 판 수집 {Math.floor(run.gold)} · 보스 {run.bossRewardGold}
              </span>
              <span>
                영구 잔액 {profile.profile.gold} · 처치 {run.kills}
              </span>
            </div>
          </div>
          {controller.session.temporary && (
            <p role="status">임시 플레이 · 보상과 기록을 저장하지 않습니다.</p>
          )}
          {(controller.saveFailed || profile.error) && (
            <div className="survivor-save-error" role="alert">
              <p>
                {profile.error ?? '저장을 완료하지 못해 도전을 멈췄습니다.'} 현재 결과를 유지합니다.
              </p>
              <button onClick={controller.retry}>저장 재시도</button>
            </div>
          )}
          <div className="survivor-field">
            <canvas
              ref={canvas}
              tabIndex={phase === 'playing' ? 0 : -1}
              aria-label="서바이버 전장 · WASD 또는 방향키 이동"
              role="img"
              data-tick={run.tick}
              data-x={Math.round(run.player.x)}
              data-y={Math.round(run.player.y)}
              onPointerDown={() => canvas.current?.focus({ preventScroll: true })}
            />
            {boss && (
              <div className="survivor-boss">
                <label htmlFor="survivor-boss-hp">
                  숲의 폭군 · HP {Math.ceil(boss.hp)} / {boss.maxHp}
                </label>
                <progress id="survivor-boss-hp" value={boss.hp} max={boss.maxHp} />
              </div>
            )}
            {run.stage.phase === 'bossWarning' && (
              <p className="survivor-warning" role="status">
                숲의 폭군이 다가옵니다
              </p>
            )}
            {phase !== 'playing' && (
              <div
                className={
                  phase === 'choosing' ? 'survivor-panel survivor-choice' : 'survivor-panel'
                }
                ref={panel}
                role="group"
                aria-label={
                  phase === 'choosing'
                    ? '성장 카드 선택'
                    : phase === 'paused'
                      ? '일시정지'
                      : phase === 'stageClear'
                        ? '스테이지 통과'
                        : '도전 결과'
                }
              >
                {phase === 'choosing' && run.choice && (
                  <>
                    <header className="survivor-choice-heading">
                      <h2>레벨 {run.level} · 성장 선택</h2>
                      <span>
                        {run.pendingChoices > 1
                          ? `남은 선택 ${run.pendingChoices}회`
                          : '전투 일시정지'}
                      </span>
                    </header>
                    <div className="survivor-cards" key={run.choice.id}>
                      {run.choice.cards.map((card, i) => (
                        <button
                          className="survivor-card"
                          data-kind={card.kind}
                          key={card.id}
                          onClick={() => choose(card.id)}
                          disabled={controller.saveFailed}
                        >
                          <small>
                            <kbd>{i + 1}</kbd>{' '}
                            {
                              {
                                weapon: '무기',
                                ability: '지속 능력',
                                evolution: '진화',
                                reward: '즉시 보상',
                              }[card.kind]
                            }
                          </small>
                          <strong>{card.name}</strong>
                          {(card.kind === 'weapon' || card.kind === 'ability') && (
                            <span>
                              {card.fromRank
                                ? `랭크 ${card.fromRank} → ${card.toRank}`
                                : '신규 · 랭크 1'}
                            </span>
                          )}
                          <span className="survivor-card-stats">
                            {card.effects.map((effect) => (
                              <span key={effect.label}>
                                {effect.label}{' '}
                                <b>
                                  {(card.fromRank > 0 ||
                                    card.kind === 'reward' ||
                                    effect.before !== 0) &&
                                    `${Number(effect.before.toFixed(2))}${effect.unit} → `}
                                  {Number(effect.after.toFixed(2))}
                                  {effect.unit}
                                </b>
                              </span>
                            ))}
                          </span>
                          {card.kind === 'evolution' && (
                            <span>조건 달성: 누적 3분 · 무기 5 · 대응 능력 3</span>
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="survivor-choice-footer">
                      <span>
                        방향키로 이동 · 1/2/3 또는 Enter로 선택
                        <small>다시 뽑으면 같은 카드가 나올 수 있습니다.</small>
                      </span>
                      <button
                        disabled={controller.saveFailed || !run.rerolls}
                        onClick={() => controller.reroll(choiceId!)}
                      >
                        다시 뽑기 (R) · {run.rerolls}회
                      </button>
                    </div>
                  </>
                )}
                {phase === 'paused' && (
                  <>
                    <h2>일시정지</h2>
                    <p>이동·공격·카드·시간을 멈췄습니다. 직접 재개해 주세요.</p>
                    <button disabled={controller.saveFailed} onClick={resume}>
                      계속하기
                    </button>
                    <button onClick={() => controller.finish('abandoned')}>
                      도전 포기하고 정산
                    </button>
                    <p>
                      WASD / 방향키: 이동 · 공격은 자동 · ◆ XP 수집 → 카드 선택 · P: 정지/재개 · M:
                      소리 · Esc: 작업으로 복귀
                    </p>
                    <p>
                      3·6·9… 구간은 보스를 처치해야 통과합니다. 다음 구간에서도 HP와 성장이
                      유지됩니다.
                    </p>
                    <p>
                      진화: 누적 전투 3분 + 무기 5랭크 + 대응 능력 3랭크. 물기·이빨 → 왕와앙,
                      부메랑·빠른 꼬리 → 황금 뼈다귀, 파동·복슬복슬 털 → 사자후. 최대 2개까지 카드로
                      선택합니다.
                    </p>
                  </>
                )}
                {phase === 'stageClear' && (
                  <>
                    <h2>스테이지 {run.stage.index} 통과</h2>
                    <p>
                      HP {Math.ceil(run.player.hp)} / {run.player.stats.maxHp} · 누적 보스 보상{' '}
                      {run.bossRewardGold} 골드
                    </p>
                    <p>레벨·장비·HP·드롭을 이어갑니다. 자동 회복과 다시 뽑기 충전은 없습니다.</p>
                    <button
                      disabled={controller.saveFailed}
                      onClick={() => {
                        gesture();
                        controller.next(stageIndex);
                      }}
                    >
                      다음 스테이지 {run.stage.index + 1}
                    </button>
                    <button
                      disabled={controller.saveFailed}
                      onClick={() => controller.finish('retired', stageIndex)}
                    >
                      정산하고 쉼터로
                    </button>
                  </>
                )}
                {phase === 'result' && (
                  <>
                    <h2>
                      {run.result === 'defeat'
                        ? '숲에서 쓰러졌어요'
                        : run.result === 'retired'
                          ? '도전을 마무리했어요'
                          : '도전을 포기했어요'}
                    </h2>
                    <p>
                      최고 통과 {run.highestCompletedStage} · 최고 도달 {run.highestReachedStage} ·
                      전투 {time(run.tick)} · 보스 {run.bossesDefeated}마리
                    </p>
                    <p>
                      레벨 {run.level} · 처치 {run.kills}
                    </p>
                    <p>
                      수집 {Math.floor(run.gold)} + 보스 {run.bossRewardGold} + 첫 보스{' '}
                      {firstBossGold} = {Math.floor(run.gold) + run.bossRewardGold + firstBossGold}{' '}
                      골드
                    </p>
                    <p>
                      {controller.session.temporary
                        ? '임시 플레이 · 지급 없음'
                        : controller.session.settled
                          ? `정산 저장 완료 · 실제 지급 ${settlement?.creditedGold ?? 0} · 총 잔액 ${profile.profile.gold}`
                          : '정산 저장 대기 · 저장 후 다음 도전을 시작할 수 있습니다.'}
                    </p>
                    <button
                      disabled={!controller.session.settled}
                      onClick={() => start(profile.profile.revision, controller.session.temporary)}
                    >
                      다시 시작
                    </button>
                    <button disabled={!controller.session.settled} onClick={controller.hub}>
                      쉼터
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="survivor-loadout" aria-label="현재 조합">
            <div>
              <strong>무기</strong>
              {Array.from({ length: 4 }, (_, i) => (
                <span key={i}>{weapons[i] ?? '빈 슬롯'}</span>
              ))}
            </div>
            <div>
              <strong>지속 능력</strong>
              {Array.from({ length: 4 }, (_, i) => (
                <span key={i}>{abilities[i] ?? '빈 슬롯'}</span>
              ))}
            </div>
          </div>
          <div className="survivor-controls">
            <div className="survivor-pad" aria-label="8방향 이동">
              {pads.map(([x, y, label]) => (
                <button
                  key={label}
                  aria-label={x || y ? `${label} 이동` : '일시정지'}
                  disabled={phase !== 'playing'}
                  onPointerDown={(e) => {
                    if (!(x || y)) return;
                    e.preventDefault();
                    gesture();
                    canvas.current?.focus({ preventScroll: true });
                    e.currentTarget.setPointerCapture(e.pointerId);
                    input.pointers.set(e.pointerId, [x, y]);
                  }}
                  onPointerUp={(e) => input.pointers.delete(e.pointerId)}
                  onPointerCancel={(e) => input.pointers.delete(e.pointerId)}
                  onLostPointerCapture={(e) => input.pointers.delete(e.pointerId)}
                  onClick={() => {
                    if (!x && !y) controller.pause();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div>
              <button onClick={toggleMute} aria-pressed={muted}>
                효과음 {muted ? '꺼짐' : '켜짐'} (M)
              </button>
              <p>누적 전투 {time(run.tick)} · P 일시정지 · Esc 작업으로</p>
              <p>◇ 골드 · + 간식 · 붉은 점선은 적의 공격 예고</p>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
