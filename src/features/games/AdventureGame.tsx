import { useCallback, useEffect, useRef, useState } from 'react';
import { DachsSprite } from './DachsSprite';
import { RoundControls, Stats, useBest, useRound, useBoardWidth, useFrame } from './shared';
import {
  ADVENTURE_FLOOR as FLOOR,
  ADVENTURE_HEIGHT,
  newAdventure,
  nextAdventure,
  retryAdventure,
  stepAdventure,
  adventureCamera,
  adventureMotion,
  type AdventureInput,
} from './adventureEngine';

import { BIOMES, randomAdventureSeed } from './adventureLevels';
import {
  AdventureScenery,
  AdventureTerrain,
  AdventureEnemies,
  AdventureBossView,
} from './AdventureWorld';
import { useAdventureAudio } from './adventureAudio';

export function DachsAdventureGame({ active }: { active: boolean }) {
  const [state, setState] = useState(() => newAdventure(randomAdventureSeed()));
  const [seedText, setSeedText] = useState(String(state.level.seed));
  const level = state.level;
  const { board, ...round } = useRound(active);
  const actualWidth = useBoardWidth(board);
  const width = Math.max(480, actualWidth);
  const best = useBest('adventure', Math.floor(state.distance));
  const playing = active && round.phase === 'playing' && !state.over;
  const sound = useAdventureAudio(state, playing);
  const held = useRef(new Set<string>());
  const pointers = useRef(new Map<number, number>());
  const input = useRef<AdventureInput>({ direction: 0 });
  const discardPending = useRef(false);
  const clear = useCallback(() => {
    held.current.clear();
    pointers.current.clear();
    input.current = { direction: 0 };
    discardPending.current = true;
  }, []);
  useEffect(() => {
    if (!playing) clear();
  }, [playing, clear]);
  const tick = useCallback((dt: number) => {
    const frameInput = { ...input.current };
    const discard = discardPending.current;
    discardPending.current = false;
    input.current.jump = false;
    input.current.bite = false;
    input.current.stomp = false;
    setState((s) =>
      stepAdventure(discard ? { ...s, pending: { direction: 0 } } : s, dt, frameInput),
    );
  }, []);
  useFrame(playing, tick);
  const syncDirection = () => {
    const directions = [...pointers.current.values()];
    input.current.direction =
      Number(held.current.has('ArrowRight') || held.current.has('d') || directions.includes(1)) -
      Number(held.current.has('ArrowLeft') || held.current.has('a') || directions.includes(-1));
  };
  const action = (kind: 'jump' | 'bite' | 'stomp') => {
    sound.unlock();
    if (playing) input.current[kind] = true;
    board.current?.focus();
  };
  const camera = adventureCamera(state, width);
  const motion = adventureMotion(state);
  const running = motion === 'run';
  const sprite =
    motion === 'hurt'
      ? 5
      : motion === 'bite'
        ? 4
        : motion === 'jump' || motion === 'fall' || motion === 'stomp'
          ? 3
          : running
            ? 1 + (Math.floor(state.elapsed * 10) % 2)
            : 0;
  const stride = Math.sin(state.elapsed * 22);
  const bounce = running
    ? Math.abs(stride) * 4
    : motion === 'idle'
      ? Math.sin(state.elapsed * 3) * 1.2
      : 0;
  const lean =
    motion === 'stomp'
      ? 32
      : motion === 'bite'
        ? 14
        : motion === 'hurt'
          ? -16
          : running
            ? stride * 3
            : motion === 'jump'
              ? -10
              : motion === 'fall'
                ? 8
                : 0;
  const loadMap = (seed: number, index = level.index) => {
    clear();
    setState(newAdventure(seed, index));
    setSeedText(String(seed));
    round.reset();
  };
  const continueGame = () => {
    clear();
    sound.unlock();
    if (state.won) setState(nextAdventure);
    else if (state.over) setState(retryAdventure);
    round.start();
  };
  return (
    <section
      className="game-play dachs-play adventure-play"
      data-biome={level.biome}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          clear();
          round.pause();
        }
      }}
    >
      <div className="adventure-heading">
        <span>
          {String(level.index + 1).padStart(2, '0')} / {level.name}
        </span>
        <span>랜덤 모험 · 시드 {level.seed}</span>
      </div>
      <details className="adventure-map-options">
        <summary>맵 선택 · 시드로 다시 플레이</summary>
        <p>같은 시드와 구간은 같은 맵입니다. 새 맵/구간 선택은 점수와 체력을 초기화합니다.</p>
        <div className="game-actions">
          {BIOMES.map((b, i) => (
            <button
              key={b.id}
              disabled={playing}
              aria-pressed={level.biome === b.id}
              onClick={() => loadMap(level.seed, i)}
            >
              {b.name}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!playing && /^\d{1,10}$/.test(seedText) && Number(seedText) <= 4294967295)
              loadMap(Number(seedText));
          }}
        >
          <label>
            맵 시드{' '}
            <input
              aria-label="맵 시드"
              inputMode="numeric"
              pattern="[0-9]{1,10}"
              required
              value={seedText}
              disabled={playing}
              onChange={(e) => setSeedText(e.target.value)}
            />
          </label>
          <button
            disabled={playing || !/^\d{1,10}$/.test(seedText) || Number(seedText) > 4294967295}
          >
            시드로 생성
          </button>
          <button type="button" disabled={playing} onClick={() => loadMap(randomAdventureSeed())}>
            새 랜덤 맵
          </button>
        </form>
        {playing && <p>맵을 바꾸려면 일시정지하세요.</p>}
      </details>
      <Stats score={state.score} best={best} bestLabel="최장 거리 (m)">
        <div>
          <span>체력</span>
          <strong data-testid="adventure-health" aria-label={`체력 ${state.health} / 5`}>
            {'♥'.repeat(state.health)}
            {'♡'.repeat(5 - state.health)}
          </strong>
        </div>
        <div>
          <span>진행</span>
          <strong>
            {Math.min(100, Math.floor(((state.furthest - 100) / (level.goal - 100)) * 100))}%
          </strong>
        </div>
      </Stats>
      <div
        ref={board}
        className="game-board dachs-board adventure-board"
        tabIndex={0}
        role="group"
        aria-label="닥스의 모험 게임판"
        data-seed={level.seed}
        data-level={level.index}
        data-x={Math.round(state.x)}
        data-y={Math.round(state.y)}
        data-camera={Math.round(camera)}
        data-motion={motion}
        data-facing={state.facing}
        data-checkpoint={state.checkpoint}
        data-boss={state.boss.mode}
        data-boss-health={state.boss.health}
        data-boss-x={Math.round(state.boss.x)}
        data-boss-y={Math.round(state.boss.y)}
        data-hitstop={state.hitstop > 0}
        onBlur={clear}
        onKeyUp={(e) => {
          const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
          if (
            [
              'ArrowLeft',
              'ArrowRight',
              'a',
              'd',
              ' ',
              'ArrowUp',
              'w',
              'j',
              'x',
              'p',
              'ArrowDown',
              's',
              'm',
            ].includes(key)
          ) {
            e.stopPropagation();
            held.current.delete(key);
            syncDirection();
          }
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
          const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
          if (
            ![
              'ArrowLeft',
              'ArrowRight',
              'a',
              'd',
              ' ',
              'ArrowUp',
              'w',
              'j',
              'x',
              'p',
              'ArrowDown',
              's',
              'm',
            ].includes(key)
          )
            return;
          e.preventDefault();
          e.stopPropagation();
          if (!active) return;
          sound.unlock();
          if (key === 'm') {
            if (!e.repeat) sound.toggle();
            return;
          }
          if (key === 'p') {
            if (e.repeat || state.over) return;
            clear();
            if (round.phase === 'paused') round.start();
            else round.pause();
            return;
          }
          if (!playing) {
            if (key === ' ' && !e.repeat) continueGame();
            return;
          }
          held.current.add(key);
          syncDirection();
          if (!e.repeat && ['ArrowUp', 'w'].includes(key)) action('jump');
          if (!e.repeat && [' ', 'j', 'x'].includes(key)) action('bite');
          if (!e.repeat && ['ArrowDown', 's'].includes(key)) action('stomp');
        }}
        onPointerDown={() => board.current?.focus()}
      >
        <svg
          viewBox={`0 0 ${width} ${ADVENTURE_HEIGHT}`}
          role="img"
          aria-label="좌우로 탐험하며 발판과 협곡을 뛰어넘고, 물기와 밟기로 적을 물리쳐 다음 구간에 도착하세요"
        >
          <g
            className="adventure-impact-camera"
            transform={`translate(${Math.sin(state.impact * 140) * state.impact * 16},${Math.cos(state.impact * 170) * state.impact * 8})`}
          >
            <AdventureScenery
              biome={level.biome}
              camera={camera}
              width={width}
              elapsed={state.elapsed}
            />
            <g transform={`translate(${-camera},0)`}>
              <AdventureTerrain state={state} />
              {state.pickups
                .filter((p) => !p.taken)
                .map((p) => (
                  <g
                    key={p.id}
                    className="adventure-treat"
                    transform={`translate(${p.x},${FLOOR - p.y + Math.sin(state.elapsed * 3 + p.id) * 3}) rotate(-25)`}
                  >
                    <title>간식 +25점</title>
                    <path d="M-9 -4H9 M-9 4H9" strokeWidth="5" />
                    {[-11, 11].map((x) => (
                      <g key={x}>
                        <circle cx={x} cy="-4" r="4" />
                        <circle cx={x} cy="4" r="4" />
                      </g>
                    ))}
                  </g>
                ))}
              <AdventureEnemies state={state} />
              <AdventureBossView state={state} />
              <ellipse
                className="adventure-shadow"
                cx={state.x}
                cy={FLOOR + 3}
                rx={Math.max(12, 32 - state.y / 9)}
                ry="4"
              />
              <g
                transform={`translate(${state.x},${FLOOR - state.y}) scale(${state.facing},1)`}
                opacity={state.shield > 0 && Math.floor(state.elapsed * 14) % 2 ? 0.4 : 1}
              >
                {state.stomping && (
                  <path
                    className="adventure-stomp-trail"
                    d="M-24 -110v36M0 -120v36M24 -110v36M-17 8L0 24 17 8"
                  />
                )}
                {running && (
                  <path
                    className="adventure-dust"
                    d={`M-35 -3h-13 M-40 -10h${-8 - Math.abs(stride) * 10}`}
                  />
                )}
                <g
                  transform={`translate(${motion === 'bite' ? 10 : 0},${-bounce}) rotate(${lean}) scale(${motion === 'bite' ? '1.16,0.86' : running ? `1,${1 - Math.abs(stride) * 0.035}` : '1,1'})`}
                >
                  <DachsSprite frame={sprite} className="adventure-sprite" />
                </g>
                {state.attack > 0 && (
                  <g className="adventure-bite">
                    <path d="M46 -65Q104 -40 55 -12 M58 -59L69 -46 81 -46 M64 -23L73 -36 87 -35" />
                  </g>
                )}
              </g>
              {state.effects.map((e) => (
                <g
                  key={e.id}
                  className={`adventure-effect ${e.kind}`}
                  opacity={e.life / 0.4}
                  transform={`translate(${e.x},${FLOOR - e.y - (0.4 - e.life) * 45})`}
                >
                  <circle r={(0.4 - e.life) * 55 + 5} />
                  <path d="M-14 -14L-23 -23 M14 -14L23 -23 M-18 8L-29 12 M18 8L29 12" />
                  {['hit', 'stomp', 'boss', 'victory'].includes(e.kind) && (
                    <g className="adventure-impact-rays">
                      {Array.from({ length: 8 }, (_, i) => (
                        <path
                          key={i}
                          transform={`rotate(${i * 45})`}
                          d={`M${10 + (0.4 - e.life) * 65} 0h${(12 * e.life) / 0.4}`}
                        />
                      ))}
                      <path
                        className="adventure-impact-star"
                        d="M0 -25L6 -8 24 -17 12 0 26 10 7 9 0 28 -6 9 -25 16 -12 0 -26 -10 -7 -9Z"
                        opacity={Math.max(0, (e.life - 0.26) / 0.14)}
                      />
                    </g>
                  )}
                  {(e.kind === 'treat' ||
                    e.kind === 'boss' ||
                    e.kind === 'victory' ||
                    e.kind === 'hit' ||
                    e.kind === 'rest' ||
                    e.kind === 'stomp' ||
                    e.kind === 'switch') && (
                    <text y="-14" textAnchor="middle">
                      {e.kind === 'boss'
                        ? '명중!'
                        : e.kind === 'victory'
                          ? '수호자 격파 +500'
                          : e.kind === 'hit'
                            ? '팍!'
                            : e.kind === 'rest'
                              ? '쉼터 도착'
                              : e.kind === 'stomp'
                                ? '밟기 +75'
                                : e.kind === 'switch'
                                  ? '문 열림'
                                  : '+25'}
                    </text>
                  )}
                </g>
              ))}
            </g>
          </g>
          <g className="adventure-route" transform={`translate(18,20)`}>
            <path d={`M0 0H${width - 36}`} />
            <circle cx={(width - 36) * Math.min(1, state.x / level.goal)} r="4" />
          </g>
          {state.boss.mode !== 'dormant' && (
            <g className="adventure-boss-hud" transform={`translate(${width / 2 - 145},38)`}>
              <rect x="-12" y="-18" width="314" height="73" rx="8" className="boss-panel" />
              <text x="145" y="0" textAnchor="middle">
                {level.arena.name} {state.boss.health === 0 ? '· 격파!' : '· BOSS'}
              </text>
              <rect y="10" width="290" height="7" rx="3" className="boss-health-track" />
              <rect
                y="10"
                width={(290 * state.boss.health) / state.boss.maxHealth}
                height="7"
                rx="3"
                className="boss-health-fill"
              />
              <text x="145" y="39" textAnchor="middle">
                {state.boss.health === 0
                  ? '출구 개방 →'
                  : state.boss.mode === 'windup'
                    ? state.boss.cycle % 2 === 0
                      ? '돌진 예고! 점프로 피하세요'
                      : '도약 예고! 착지 지점을 피하세요'
                    : state.boss.mode === 'recover'
                      ? '빈틈! Space 물기 · 머리 밟기 2 피해'
                      : 'Space 물기 · 머리 밟기 2 피해'}
              </text>
            </g>
          )}
          {(round.phase !== 'playing' || state.over) && (
            <g className="adventure-overlay">
              <rect x={width / 2 - 168} y="102" width="336" height="118" rx="8" />
              <text x={width / 2} y="141" textAnchor="middle" className="adventure-overlay-title">
                {state.won
                  ? `${level.name} 통과!`
                  : state.over
                    ? '잠깐 쉬었다 다시 모험해요'
                    : round.phase === 'paused'
                      ? '모험을 잠시 멈췄어요'
                      : level.name}
              </text>
              <text x={width / 2} y="171" textAnchor="middle">
                {state.over
                  ? `간식과 전투 점수 ${state.score}점`
                  : '← → 이동 · ↑ 점프 · Space 물기 · ↓ 밟기'}
              </text>
              <text x={width / 2} y="195" textAnchor="middle">
                {state.won
                  ? 'SPACE  다음 스테이지로 출발'
                  : state.over
                    ? 'SPACE  마지막 쉼터에서 재도전'
                    : round.phase === 'paused'
                      ? 'SPACE / P  계속하기'
                      : 'SPACE  모험 시작'}
              </text>
            </g>
          )}
        </svg>
      </div>
      <p className="dachs-help">
        ← → / A D 이동 · ↑ / W 점프 · Space 물기 · 공중 ↓ / S 밟기 · P 정지/재개 · M 소리
        <br />
        {level.hint} 적 위로 내려오면 자동 밟기 +75점 · 쉼터에서 체력 +1
      </p>
      <div className="game-actions dachs-touch-controls adventure-controls">
        {([-1, 1] as const).map((direction) => (
          <button
            key={direction}
            disabled={!playing}
            aria-label={direction < 0 ? '왼쪽으로' : '오른쪽으로'}
            onPointerDown={(e) => {
              e.preventDefault();
              board.current?.focus();
              e.currentTarget.setPointerCapture(e.pointerId);
              pointers.current.set(e.pointerId, direction);
              syncDirection();
            }}
            onPointerUp={(e) => {
              pointers.current.delete(e.pointerId);
              syncDirection();
            }}
            onPointerCancel={(e) => {
              pointers.current.delete(e.pointerId);
              syncDirection();
            }}
            onLostPointerCapture={(e) => {
              pointers.current.delete(e.pointerId);
              syncDirection();
            }}
            onClick={(e) => {
              if (e.detail === 0 && playing) {
                setState((s) => stepAdventure(s, 0.05, { direction }));
                board.current?.focus();
              }
            }}
          >
            {direction < 0 ? '← 이동' : '이동 →'}
          </button>
        ))}
        {(['jump', 'bite', 'stomp'] as const).map((kind) => (
          <button
            key={kind}
            disabled={!playing}
            onPointerDown={(e) => {
              e.preventDefault();
              action(kind);
            }}
            onClick={(e) => {
              if (e.detail === 0) action(kind);
            }}
          >
            {kind === 'jump' ? '↑ 점프' : kind === 'bite' ? 'Space 물기' : '↓ 밟기'}
          </button>
        ))}
      </div>
      <p className="game-status" role="status">
        {state.won
          ? `구간 완료! ${level.name} · ${state.score}점 · Space 다음 스테이지`
          : state.over
            ? '게임 종료 · Space로 마지막 쉼터에서 재도전'
            : round.phase === 'ready'
              ? 'Space를 눌러 모험을 시작하세요.'
              : round.phase === 'paused'
                ? '일시정지 · Space / P 계속하기'
                : '플레이 중'}
      </p>
      {state.won && (
        <button className="adventure-next" onClick={continueGame}>
          다음 구간 → {BIOMES[(level.index + 1) % BIOMES.length].name}
        </button>
      )}
      {state.over && !state.won && <button onClick={continueGame}>Space 쉼터에서 재도전</button>}
      <button
        className="adventure-sound"
        aria-pressed={!sound.muted}
        onClick={() => {
          sound.toggle();
          board.current?.focus();
        }}
      >
        효과음 {sound.muted ? '꺼짐' : '켜짐'} · M
      </button>
      <RoundControls
        round={{
          ...round,
          start: () => {
            sound.unlock();
            round.start();
          },
        }}
        over={state.over}
        restart={() => {
          clear();
          setState(newAdventure(level.seed, level.index));
        }}
      />
    </section>
  );
}
