import { useEffect, useState } from 'react';
import { DachsSprite } from './DachsSprite';
import {
  DACHS_HEIGHT,
  SNACK_FLOOR,
  SNACK_SECONDS,
  snackMotion,
  type Snack,
  type Treat,
} from './dachsEngines';

export function TreatShape({ kind }: { kind: Treat['kind'] }) {
  if (kind === 'star')
    return (
      <polygon
        points="0,-15 4,-5 15,-5 7,3 10,14 0,8 -10,14 -7,3 -15,-5 -4,-5"
        fill="currentColor"
      />
    );
  if (kind === 'onion')
    return (
      <g className="dachs-onion">
        <path d="M0 -16 Q-5 -9 -10 -5 C-27 15 27 15 10 -5 Q5 -9 0 -16Z" />
        <path d="M0 -16 Q-9 3 0 11 Q9 3 0 -16 M0 -16 L-4 -23 M0 -16 L5 -22" />
      </g>
    );
  return (
    <g fill="currentColor" transform="rotate(-25)">
      <rect x="-10" y="-4" width="20" height="8" />
      {[-11, 11].flatMap((x) =>
        [-4, 4].map((y) => <circle key={`${x},${y}`} cx={x} cy={y} r="5" />),
      )}
    </g>
  );
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return reduced;
}

export function SnackScene({
  state: s,
  width,
  phase,
}: {
  state: Snack;
  width: number;
  phase: string;
}) {
  const reduced = useReducedMotion();
  const motion = snackMotion(s);
  const running = motion === 'run';
  const stride = Math.sin(s.stride * Math.PI);
  const frame =
    motion === 'hurt'
      ? 5
      : motion === 'eat'
        ? 4
        : motion === 'jump'
          ? 3
          : running
            ? 1 + (Math.floor(s.stride) % 2)
            : 0;
  const hop =
    motion === 'jump'
      ? Math.sin(Math.PI * (1 - s.reaction / 0.5)) * 20
      : running
        ? Math.abs(stride) * 3
        : motion === 'idle'
          ? Math.sin(s.elapsed * 3)
          : 0;
  const chew = motion === 'eat' ? Math.sin(s.reaction * 42) : 0;
  const lean = motion === 'hurt' ? (-10 * s.reaction) / 0.42 : running ? stride * 2 : chew * 2;
  const overlay = phase !== 'playing' || s.over;
  return (
    <>
      <svg
        viewBox={`0 0 ${width} ${DACHS_HEIGHT}`}
        role="img"
        aria-label="간식과 별은 받고 양파는 피하세요"
        data-reduced-motion={reduced}
      >
        <g className="snack-scenery" aria-hidden="true">
          <circle cx={width - 75} cy="82" r="28" />
          <path
            d={`M0 240 Q${width * 0.25} 130 ${width * 0.5} 240 Q${width * 0.75} 165 ${width} 235 V325 H0Z`}
          />
          {[48, width - 44].map((x) => (
            <g key={x} transform={`translate(${x},0)`}>
              <path d="M0 292V165 M0 218L-21 201 M0 239L22 215" />
              <ellipse cy="165" rx="37" ry="51" />
            </g>
          ))}
        </g>
        <g className="snack-canopy" aria-hidden="true">
          <path d={`M0 12 Q${width / 2} 42 ${width} 12`} />
          {Array.from({ length: Math.floor(width / 46) }, (_, i) => (
            <path key={i} d={`M${i * 46 + 13} 22l10 16 10 -16`} />
          ))}
        </g>
        <g className="snack-floor" aria-hidden="true">
          <rect y={SNACK_FLOOR} width={width} height="35" />
          <path d={`M0 ${SNACK_FLOOR} H${width}`} />
          <path d={`M0 ${SNACK_FLOOR + 18} H${width}`} strokeDasharray="2 22" />
        </g>
        {s.items.map((item) => (
          <g
            key={item.id}
            className={`snack-item ${item.kind}`}
            transform={`translate(${item.x},${item.y})`}
          >
            <title>
              {item.kind === 'bone'
                ? '간식 10점'
                : item.kind === 'star'
                  ? '별 30점'
                  : '양파 목숨 감소'}
            </title>
            {item.kind === 'onion' && <circle className="snack-hazard-ring" r="22" />}
            {item.kind === 'star' && <circle className="snack-star-halo" r="22" />}
            <g transform={`rotate(${reduced ? 0 : Math.sin(s.elapsed * 3 + item.id) * 14})`}>
              <TreatShape kind={item.kind} />
            </g>
          </g>
        ))}
        <ellipse
          className="adventure-shadow"
          cx={s.x}
          cy={SNACK_FLOOR + 3}
          rx={34 - (reduced ? 0 : hop * 0.3)}
          ry="4"
        />
        <g
          className="snack-dog"
          transform={`translate(${s.x},${SNACK_FLOOR}) scale(${s.facing},1)`}
          opacity={s.shield > 0 ? 0.6 : 1}
        >
          {running && !reduced && (
            <path
              className="adventure-dust"
              d={`M-40 -3h-13 M-46 -10h${-8 - Math.abs(stride) * 10}`}
            />
          )}
          <g
            transform={`translate(${reduced ? 0 : chew * 1.5},${reduced ? 0 : -hop}) rotate(${reduced ? 0 : lean}) scale(1,${reduced ? 1 : 1 - Math.abs(chew) * 0.035})`}
          >
            <DachsSprite frame={frame} className="snack-sprite" />
          </g>
          {motion === 'eat' && (
            <g className="snack-crumbs" opacity={s.reaction / 0.32}>
              {[0, 1, 2].map((i) => (
                <circle
                  key={i}
                  cx={43 + i * 6}
                  cy={-42 + i * 7 - (reduced ? 0 : s.reaction * 12)}
                  r="1.8"
                />
              ))}
            </g>
          )}
        </g>
        {s.effects.map((effect) => {
          const age = 1 - effect.life / 0.7;
          return (
            <g
              key={effect.id}
              className={`snack-effect ${effect.kind}`}
              opacity={Math.min(1, effect.life * 4)}
              transform={`translate(${Math.max(30, Math.min(width - 30, effect.x))},${SNACK_FLOOR - 72 - (reduced ? 0 : age * 38)})`}
            >
              {!reduced && (
                <g className="snack-sparks">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <circle
                      key={i}
                      cx={Math.cos(i * 1.26) * (8 + age * 28)}
                      cy={Math.sin(i * 1.26) * (8 + age * 28)}
                      r={2 * (1 - age)}
                    />
                  ))}
                </g>
              )}
              <text textAnchor="middle" y="-12">
                {effect.kind === 'onion' ? '앗! −1' : effect.kind === 'star' ? '★ +30' : '+10'}
              </text>
            </g>
          );
        })}
        {!overlay && (
          <text className="snack-mood" x={width / 2} y="64" textAnchor="middle">
            {s.reaction > 0
              ? motion === 'hurt'
                ? '양파는 피해요!'
                : motion === 'jump'
                  ? '별 간식이다!'
                  : '냠냠!'
              : s.combo >= 3
                ? `${s.combo}개 연속 받는 중!`
                : s.elapsed >= 35
                  ? '마지막까지 냠냠!'
                  : ''}
          </text>
        )}
      </svg>
      {overlay && (
        <div className="snack-overlay">
          <div className="snack-overlay-card">
            <span className="snack-eyebrow">
              {s.over
                ? '오늘의 간식 기록'
                : phase === 'paused'
                  ? 'TAKE A PAUSE'
                  : 'DACHS’S SNACK TIME'}
            </span>
            <h3>
              {s.over
                ? s.lives > 0
                  ? '잘 먹었습니다!'
                  : '잠깐, 배를 쉬어가요'
                : phase === 'paused'
                  ? '간식은 기다려줄게요'
                  : '오늘도, 간식은 진심'}
            </h3>
            <p>
              {s.over
                ? `${s.score.toLocaleString()}점 · 간식 ${s.caught - s.stars}개 · 별 ${s.stars}개`
                : phase === 'paused'
                  ? '현재 기록과 남은 시간은 그대로예요.'
                  : `${SNACK_SECONDS}초 동안 떨어지는 간식을 받아주세요.`}
            </p>
            <p className="snack-overlay-note">
              {s.over
                ? `최대 ${s.bestCombo}개 연속 받기 · 아래에서 다시 도전`
                : phase === 'paused'
                  ? '아래 계속하기로 다시 냠냠'
                  : '← → / A D 이동 · 터치하거나 드래그'}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
