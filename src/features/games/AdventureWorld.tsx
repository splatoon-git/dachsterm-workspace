import { ADVENTURE_FLOOR as FLOOR, platformAvailable, type Adventure } from './adventureEngine';
import { groundSegments, platformPosition, ventPhase, type Biome } from './adventureLevels';

export function AdventureScenery({
  biome,
  camera,
  width,
  elapsed,
}: {
  biome: Biome;
  camera: number;
  width: number;
  elapsed: number;
}) {
  const id = useId();
  return (
    <g aria-hidden="true" className={`adventure-landscape ${biome}`}>
      <defs>
        <linearGradient id={`${id}-sky`} x2="0" y2="1">
          <stop stopColor="var(--adventure-accent)" stopOpacity={biome === 'cave' ? '.3' : '.22'} />
          <stop offset="1" stopColor="var(--terminal-background)" />
        </linearGradient>
        <radialGradient id={`${id}-light`}>
          <stop stopColor="var(--terminal-yellow)" stopOpacity=".3" />
          <stop offset="1" stopColor="var(--terminal-yellow)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect fill={`url(#${id}-sky)`} width={width} height="360" />
      <ellipse fill={`url(#${id}-light)`} cx={width - 110} cy="60" rx="210" ry="170" />
      {biome !== 'cave' && (
        <g className="adventure-clouds" transform={`translate(${-((camera * 0.07) % 300)},0)`}>
          {Array.from({ length: Math.ceil(width / 300) + 1 }, (_, i) => (
            <path
              key={i}
              d={`M${i * 300} ${62 + (i % 2) * 30}q15 -19 35 -6q12 -31 42 -17q25 -4 34 23Z`}
            />
          ))}
        </g>
      )}
      {biome !== 'cave' && (
        <circle className="adventure-orb" cx={width - 80} cy="65" r={biome === 'snow' ? 21 : 29} />
      )}
      <g className="adventure-far">
        {Array.from({ length: Math.ceil(width / 260) + 2 }, (_, i) => (
          <g key={i} transform={`translate(${i * 260 - ((camera * 0.15) % 260) - 100},0)`}>
            {biome === 'forest' ? (
              <path d="M0 300Q75 60 210 260Q290 140 350 300Z" />
            ) : biome === 'ruins' ? (
              <path d="M0 300V180H20V120H40V180H65V105H85V180H110V140H130V300 M160 300V170Q210 90 260 170V300H240V185Q210 140 180 185V300Z" />
            ) : biome === 'snow' ? (
              <>
                <path d="M0 300L150 80 300 300Z" />
                <path
                  className="adventure-snowcap"
                  d="M100 154L150 80 202 156 172 146 150 162 130 140Z"
                />
              </>
            ) : (
              <path d="M0 0V60L30 40 50 125 80 55 100 160 130 40 160 75 190 25 210 115 245 45 280 65V0Z" />
            )}
          </g>
        ))}
      </g>
      <g className="adventure-horizon" transform={`translate(${-((camera * 0.24) % 440)},0)`}>
        {Array.from({ length: Math.ceil(width / 440) + 2 }, (_, i) => (
          <path key={i} d={`M${i * 440 - 200} 300q90 -112 205 -55t235 55Z`} />
        ))}
      </g>
      <g className="adventure-near">
        {Array.from({ length: Math.ceil(width / 180) + 2 }, (_, i) => (
          <g key={i} transform={`translate(${i * 180 - ((camera * 0.4) % 180) - 40},0)`}>
            {biome === 'forest' ? (
              <>
                <path d="M45 300V135M45 180L20 160M45 205L72 178" />
                <path d="M-2 158Q-2 80 45 85Q104 85 90 158Z" />
                <path d="M100 300q20 -40 40 0M110 300v-15" />
              </>
            ) : biome === 'ruins' ? (
              <>
                <path d="M30 300V205H50V300M20 205H60V194H20Z M110 300V140H130V300M100 140H140V130H100Z" />
                <path d="M0 290Q40 278 80 290T180 290" />
              </>
            ) : biome === 'cave' ? (
              <>
                <path d="M30 300L12 255 30 220 46 254Z M30 300L65 234 80 267 62 300Z M110 300L125 270 145 300Z" />
                <path d="M30 220V300M65 234L62 300" />
              </>
            ) : (
              <>
                <path d="M30 300V205M0 250L30 185 60 250H45L72 280H-12L15 250Z" />
                <path d="M110 300q20 -20 65 0" />
              </>
            )}
          </g>
        ))}
      </g>
      {Array.from({ length: 16 }, (_, i) => (
        <g
          key={i}
          className="adventure-weather"
          transform={`translate(${(((i * 83 + elapsed * (biome === 'snow' ? -28 : 9) - camera * 0.2) % (width + 30)) + width + 30) % (width + 30)},${35 + ((i * 41 + elapsed * (biome === 'snow' ? 22 : 4)) % 245)})`}
        >
          {biome === 'snow' ? (
            <path d="M-3 0H3M0 -3V3" />
          ) : biome === 'forest' ? (
            <path d="M-3 0Q0 -5 5 -1Q1 4 -3 0" />
          ) : biome === 'cave' ? (
            <circle r="1.4" />
          ) : (
            <path d="M-5 0q5 -4 10 0" />
          )}
        </g>
      ))}
    </g>
  );
}
export function AdventureTerrain({ state }: { state: Adventure }) {
  const level = state.level;
  return (
    <>
      <g className="adventure-props" aria-hidden="true">
        {level.chunks.map((chunk, i) => (
          <g key={chunk.x} transform={`translate(${chunk.x + 160},300)`}>
            {level.biome === 'forest' ? (
              <>
                <path className="prop-dark" d="M-90 0Q-65 -85 -81 -200L-58 -203Q-44 -110 -55 0Z" />
                <path d="M-73 -146q-60 -12 -70 -57q70 2 77 41M-62 -168q25 -67 81 -62q-4 54 -79 78" />
                <path
                  className="prop-leaves"
                  d="M-145 -188q-24 -65 36 -75q-6 -45 55 -30q72 -32 91 24q68 13 39 67q-45 31 -80 0q-71 48 -141 14Z"
                />
                <path
                  className="prop-detail"
                  d="M-69 -33l5 -47m-10 -12 4 -32M-120 0q2 -27 17 -30q-12 18 -7 30m10 0q13 -21 23 -16"
                />
                <ellipse cx="-66" cy="-113" rx="10" ry="16" className="prop-dark" />
              </>
            ) : level.biome === 'ruins' ? (
              <>
                <path d="M-115 0V-160q83 -77 166 0V0H23V-150q-55 -43 -110 0V0Z" />
                <path
                  className="prop-detail"
                  d="M-115 -80h28m-28 -38h28m110 15h28m-28 40h28M-102 -167l11 15m20 -32 6 16m28 -25v18m30 -16 -5 18m25 -9 -9 16"
                />
                <path
                  className="prop-vine"
                  d="M-101 -190q20 35 0 70t8 70m-5 -100 -15 9m12 21 17 7"
                />
                <path className="prop-water" d="M-70 -120v105m8 -105v105m-8 -85h8m-8 45h8" />
              </>
            ) : level.biome === 'cave' ? (
              <>
                <path className="prop-dark" d="M-130 0l17 -119 60 -49 70 38 40 130Z" />
                <path
                  className="prop-crystal"
                  d="M-79 0l-30 -100 26 -42 28 40Z M-55 0l22 -178 29 -30 31 47 -40 161Z M-17 0l52 -89 30 -13 16 38 -55 64Z"
                />
                <path
                  className="prop-detail"
                  d="M-83 -142l4 142m75 -208 -9 208m48 -89 -9 89M-109 -100l26 15 28 -17M-33 -178l29 28 31 -11"
                />
              </>
            ) : (
              <>
                <path className="prop-dark" d="M-55 0v-181h12V0Z" />
                <path d="M-49 -245l-48 78h22l-55 80h35l-59 67H54L-7 -87h38l-55 -80H1Z" />
                <path
                  className="prop-snow"
                  d="M-49 -245l-48 78 27 -8 21 10 22 -11 28 9Z M-75 -147l-55 60 40 -10 35 10 33 -10 53 10 -55 -60 -26 19Z"
                />
              </>
            )}
            <g transform={`translate(${i % 2 ? 230 : -90},0)`} className="adventure-waystone">
              <path d="M-21 0l4 -25 18 -9 20 17L26 0Z" />
              <path className="prop-detail" d="M-6 -17l8 5 -6 5m8 -13 7 6" />
            </g>
          </g>
        ))}
      </g>
      {groundSegments(level).map((g) => (
        <g key={g.x} className="adventure-ground">
          <rect x={g.x} y={FLOOR} width={g.end - g.x} height={60} />
          <path d={`M${g.x} ${FLOOR}H${g.end}`} />
          <rect
            className="adventure-ground-cap"
            x={g.x}
            y={FLOOR}
            width={g.end - g.x}
            height="7"
            rx="2"
          />
          {Array.from({ length: Math.floor((g.end - g.x) / 55) }, (_, i) => (
            <g
              key={i}
              className="adventure-ground-stone"
              transform={`translate(${g.x + i * 55 + 8},${FLOOR + 18 + (i % 2) * 14})`}
            >
              <path d="M0 0l12 -4 20 3 3 9 -24 3Z" />
              <path d="M3 1l10 -2m-1 10 13 -2" />
            </g>
          ))}
          <path
            d={`M${g.x} ${FLOOR + 14}H${g.end}`}
            strokeDasharray={level.biome === 'ruins' ? '28 6' : '2 18'}
          />
        </g>
      ))}
      {level.gaps.map((g) => (
        <g key={g.x} className="adventure-gap">
          <path d={`M${g.x + 4} 344q15 -9 30 0t30 0t30 0t30 0t30 0`} />
          <text x={g.x + g.width / 2} y="333" textAnchor="middle">
            {level.biome === 'ruins' ? '물길' : '낭떠러지'}
          </text>
        </g>
      ))}
      {level.platforms.map((original) => {
        const p = platformPosition(original, state.elapsed);
        const visible = platformAvailable(original, state);
        const cracking = state.crumbling[p.id] !== undefined;
        return (
          <g
            key={p.id}
            className={`adventure-platform ${p.kind}`}
            opacity={visible ? 1 : 0.16}
            data-platform={p.id}
            data-available={visible}
          >
            {p.kind === 'moving' && (
              <path
                className="adventure-track"
                d={`M${original.x - (p.travel ?? 0)} ${FLOOR - p.y + 25}h${(p.travel ?? 0) * 2 + p.width}`}
                strokeDasharray="3 6"
              />
            )}
            <rect x={p.x} y={FLOOR - p.y} width={p.width} height="13" rx="3" />
            <path
              className="adventure-platform-top"
              d={`M${p.x + 4} ${FLOOR - p.y + 2}h${p.width - 8}`}
            />
            <path
              className="adventure-platform-underside"
              d={`M${p.x + 7} ${FLOOR - p.y + 14}l12 10h${p.width - 38}l12 -10`}
            />
            {p.kind === 'moving' && (
              <text x={p.x + p.width / 2} y={FLOOR - p.y + 10} textAnchor="middle">
                ↔
              </text>
            )}
            {p.kind === 'crumble' && (
              <path
                d={`M${p.x + 30} ${FLOOR - p.y}l8 5 -4 8m35 -13l-7 6 10 7${cracking ? 'm20 -13l-10 7 8 6' : ''}`}
              />
            )}
          </g>
        );
      })}
      {level.spikes.map((s) => (
        <g className="adventure-spikes" key={s.x}>
          <title>가시 · 점프로 피하세요</title>
          {Array.from({ length: Math.ceil(s.width / 15) }, (_, i) => (
            <path key={i} d={`M${s.x + i * 15} ${FLOOR}l7 -22 8 22Z`} />
          ))}
        </g>
      ))}
      {level.springs.map((x) => (
        <g key={x} className="adventure-spring" transform={`translate(${x},${FLOOR})`}>
          <title>통통 버섯 · 밟으면 높이 점프</title>
          <path d="M-8 0V-13H8V0 M-25 -12Q-23 -42 0 -42Q23 -42 25 -12Z" />
          <path d="M-7 -23l7 -8 7 8M0 -31v15" />
          <text y="-52" textAnchor="middle">
            통통!
          </text>
        </g>
      ))}
      {level.ice.map((p) => (
        <g key={p.x} className="adventure-ice">
          <rect x={p.x} y="298" width={p.width} height="10" />
          <path d={`M${p.x + 20} 305l35 -7m35 7 35 -7m35 7 35 -7m35 7 35 -7`} />
          <text x={p.x + p.width / 2} y="325" textAnchor="middle">
            미끄러운 얼음
          </text>
        </g>
      ))}
      {level.vents.map((p) => {
        const phase = ventPhase(state.elapsed, p.phase);
        return (
          <g
            key={p.x}
            className={`adventure-vent ${phase}`}
            transform={`translate(${p.x},300)`}
            data-vent={phase}
          >
            <title>증기 분출구 · 예고 뒤 분출</title>
            <path d="M-25 0l6 -9h38l6 9Z" />
            <text y="-20" textAnchor="middle">
              {phase === 'warning' ? '!' : phase === 'quiet' ? '···' : ''}
            </text>
            {phase === 'active' && (
              <>
                <path d="M-20 -10Q-35 -40 -15 -85M0 -10Q-12 -42 4 -100M20 -10Q35 -45 17 -85" />
                <path d="M-20 -10H20L30 -80H-30Z" className="adventure-steam" />
              </>
            )}
          </g>
        );
      })}
      {level.gates.map((g) => (
        <g key={g.id} className="adventure-gate" data-open={state.switches.includes(g.id)}>
          <g transform={`translate(${g.switchX},300)`}>
            <path d="M0 0V-45M-12 0H12" />
            <circle cy="-48" r="10" />
            <text y="-72" textAnchor="middle">
              {state.switches.includes(g.id) ? '열림 ✓' : 'Space로 물기'}
            </text>
          </g>
          <path className="adventure-wire" d={`M${g.switchX} 298H${g.x}`} />
          {!state.switches.includes(g.id) && (
            <g transform={`translate(${g.x},300)`}>
              <rect x="-12" y="-180" width="24" height="180" />
              <path d="M-10 -160H10M-10 -130H10M-10 -100H10M-10 -70H10M-10 -40H10" />
            </g>
          )}
        </g>
      ))}
      {level.checkpoints.map((x) => (
        <g
          key={x}
          className="adventure-checkpoint"
          transform={`translate(${x},${FLOOR})`}
          opacity={state.checkpoint >= x ? 1 : 0.45}
        >
          <path d="M0 0V-85M0 -85L40 -70 0 -55" />
          <text y="-98" textAnchor="middle">
            {state.checkpoint >= x ? '저장 완료' : '쉼터'}
          </text>
        </g>
      ))}
      <g className="adventure-arena" aria-hidden="true">
        <path
          className="arena-floor"
          d={`M${level.arena.start} 312h${level.arena.end - level.arena.start}v48H${level.arena.start}Z`}
        />
        {[level.arena.start, level.arena.end].map((x) => (
          <g key={x} transform={`translate(${x},300)`}>
            <path
              className="arena-pillar"
              d="M-22 0v-133l8 -10v-21H14v21l8 10V0ZM-29 -166v-11h58v11Z"
            />
            <path className="arena-rune" d="M0 -138l10 16 -10 16 -10 -16ZM0 -99v55m-10 -30h20" />
            <circle className="arena-beacon" cy="-192" r="10" />
            {state.boss.health > 0 && state.boss.mode !== 'dormant' && (
              <path className="arena-barrier" d="M0 -155V0m-7 -150V0m14 -150V0" />
            )}
          </g>
        ))}
        <text
          x={(level.arena.start + level.arena.end) / 2}
          y="143"
          textAnchor="middle"
          className="arena-name"
        >
          {level.arena.name}
        </text>
        <path className="arena-sigil" d={`M${level.arena.bossX - 70} 326l70 -13 70 13 -70 17Z`} />
      </g>
      <g className="adventure-home" transform={`translate(${level.goal},${FLOOR})`}>
        <path d="M-40 0V-90Q0 -135 40 -90V0M-25 0V-87Q0 -110 25 -87V0" />
        <text y="-135" textAnchor="middle">
          {state.boss.health > 0 ? '수호자를 물리치세요' : 'NEXT →'}
        </text>
      </g>
    </>
  );
}
export function AdventureBossView({ state }: { state: Adventure }) {
  const b = state.boss;
  if (b.health === 0) return null;
  return (
    <g className={`adventure-boss ${state.level.biome} ${b.mode}`} data-mode={b.mode}>
      <ellipse className="adventure-shadow" cx={b.x} cy="303" rx={65 - b.y / 8} ry="8" />
      {b.mode === 'windup' && (
        <path className="boss-danger-zone" d={`M${b.x} 298h${b.direction * 290}`} />
      )}
      <g transform={`translate(${b.x},${FLOOR - b.y}) scale(${b.direction},1)`}>
        <g
          className="boss-body"
          opacity={b.shield > 0 && Math.floor(state.elapsed * 24) % 2 ? 0.5 : 1}
        >
          <path className="boss-leg" d="M-42 -15l-7 14h20l7 -14M21 -15l8 14h20l-7 -17" />
          <path
            className="boss-shell"
            d="M-60 -15q-10 -48 29 -62q50 -21 81 25l16 10v25Q0 8 -60 -15Z"
          />
          <path
            className="boss-armor"
            d="M-54 -43l18 -18 23 4 22 -12 23 15 -7 18 -22 4 -15 -8 -23 12Z"
          />
          {state.level.biome === 'forest' ? (
            <path
              className="boss-crown"
              d="M-42 -65q-20 -30 -2 -37l15 20q10 -34 25 -25l-2 25q31 -23 39 -9l-17 20Z"
            />
          ) : state.level.biome === 'ruins' ? (
            <path className="boss-crown" d="M-43 -67v-23h17v9h18v-18H9v22h18v-9h14v27Z" />
          ) : state.level.biome === 'cave' ? (
            <path
              className="boss-crown"
              d="M-45 -64l-9 -27 13 -17 14 35 8 -41 19 8 9 27 20 -24 15 22 -17 20Z"
            />
          ) : (
            <path
              className="boss-crown"
              d="M-41 -64l-10 -28 20 11 10 -24 16 24 16 -21 10 28 21 -11 -7 24Z"
            />
          )}
          <path className="boss-face" d="M30 -53q25 -4 30 16l17 3v20H39L24 -28Z" />
          <path className="boss-tusk" d="M48 -17q15 -3 13 -20q16 24 -9 28" />
          <path className="boss-eye" d="M42 -39l10 3" />
          <path
            className="boss-detail"
            d="M-48 -22l16 -5m4 10 16 -5m1 -25 10 10 12 -10M-21 -61l4 15"
          />
        </g>
        {b.mode === 'windup' && (
          <text y="-120" textAnchor="middle" className="boss-warning">
            !
          </text>
        )}
        {b.mode === 'recover' && (
          <g className="boss-dizzy">
            <path d="M-20 -101h8m-4 -4v8M13 -98h8m-4 -4v8" />
            <ellipse cy="-98" rx="35" ry="8" />
          </g>
        )}
        {b.mode === 'charge' && (
          <path className="boss-speed" d="M-76 -17h-25M-80 -33h-36M-71 -49h-20" />
        )}
      </g>
    </g>
  );
}
export function AdventureEnemies({ state }: { state: Adventure }) {
  return (
    <>
      {state.enemies
        .filter((e) => e.alive)
        .map((e) => (
          <g
            key={e.id}
            className={`adventure-enemy ${e.kind} ${e.mode}`}
            data-kind={e.kind}
            transform={`translate(${e.x},${FLOOR - e.y}) scale(${e.direction},1)`}
          >
            <title>
              {e.kind === 'spike'
                ? '가시 몬스터'
                : e.kind === 'hopper'
                  ? '점프 슬라임'
                  : e.kind === 'bat'
                    ? '동굴 박쥐'
                    : '돌진 멧돼지'}{' '}
              · 물기 50점 / 밟기 75점
            </title>
            {e.kind === 'spike' ? (
              <>
                <path d="M-25 -5L-23 -20 -16 -22 -18 -34 -7 -29 0 -41 7 -29 20 -34 18 -21Q32 -15 27 -4Z" />
                <circle cx="14" cy="-16" r="3" />
              </>
            ) : e.kind === 'hopper' ? (
              <>
                <path d="M-25 -3Q-29 -34 0 -34Q29 -34 25 -3Q0 5 -25 -3Z" />
                <circle cx="8" cy="-19" r="3" />
                <circle cx="19" cy="-19" r="3" />
                <path d="M8 -9q5 4 10 0" />
              </>
            ) : e.kind === 'bat' ? (
              <>
                <path
                  d={`M-8 -12Q-30 ${-45 + Math.sin(state.elapsed * 20) * 15} -48 -8L-30 -12 -22 0 -8 -2M8 -12Q30 ${-45 + Math.sin(state.elapsed * 20) * 15} 48 -8L30 -12 22 0 8 -2`}
                />
                <path d="M-10 -20L-7 -32 0 -24 7 -32 10 -20V0H-10Z" />
                <circle cx="-4" cy="-15" r="2" />
                <circle cx="4" cy="-15" r="2" />
              </>
            ) : (
              <>
                <path d="M-30 -5V-24Q-20 -40 10 -29L17 -36 21 -24 35 -20V-6Z" />
                <path d="M-22 -4v7M18 -4v7M27 -7l5 -9 5 9" />
                <circle cx="20" cy="-21" r="3" />
                {e.mode === 'windup' && (
                  <text x="0" y="-49" textAnchor="middle">
                    !
                  </text>
                )}
                {e.mode === 'charge' && <path d="M-40 -9h-14M-38 -20h-18" />}
              </>
            )}
          </g>
        ))}
    </>
  );
}
import { useId } from 'react';
