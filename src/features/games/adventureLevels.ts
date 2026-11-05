export type Biome = 'forest' | 'ruins' | 'cave' | 'snow';
export type EnemyKind = 'spike' | 'hopper' | 'bat' | 'boar';
export type Platform = {
  id: number;
  x: number;
  y: number;
  width: number;
  kind: 'stone' | 'moving' | 'crumble';
  travel?: number;
  phase?: number;
};
export type Span = { x: number; width: number };
export type Level = {
  seed: number;
  index: number;
  biome: Biome;
  name: string;
  hint: string;
  end: number;
  goal: number;
  gaps: Span[];
  spikes: Span[];
  platforms: Platform[];
  springs: number[];
  ice: Span[];
  vents: { x: number; phase: number }[];
  gates: { id: number; x: number; switchX: number }[];
  checkpoints: number[];
  enemies: { x: number; kind: EnemyKind; range: number }[];
  treats: { x: number; y: number }[];
  chunks: { x: number; kind: string }[];
};
export const BIOMES: { id: Biome; name: string; hint: string }[] = [
  { id: 'forest', name: '바람숲', hint: '통통 버섯과 뛰는 슬라임 · 적 머리를 밟으면 다시 점프!' },
  { id: 'ruins', name: '물길 유적', hint: '이동 발판을 타고, 손잡이를 Space로 물어 문을 여세요.' },
  {
    id: 'cave',
    name: '수정 동굴',
    hint: '증기가 잦아들 때 통과하세요. 금 간 발판은 곧 무너집니다.',
  },
  {
    id: 'snow',
    name: '눈바람 고개',
    hint: '얼음에서는 제동이 느려요. 돌진 멧돼지의 ! 표시를 살피세요.',
  },
];
export function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const randomAdventureSeed = () => Math.floor(Math.random() * 0x100000000) >>> 0;
// Each 480-unit chunk reserves safe entry/exit zones. Gaps <= 135 are below the
// 190-unit running jump range; springs bridge their own 160-unit gap. Bonus routes
// never replace the traversable ground path. Seed+index fully determine a level.
export function generateLevel(seed: number, index = 0): Level {
  const safeIndex = Math.max(0, Math.floor(index));
  const biome = BIOMES[safeIndex % BIOMES.length];
  const random = seededRandom((seed >>> 0) ^ Math.imul(safeIndex + 1, 0x9e3779b9));
  const options = {
    forest: ['spring', 'steps', 'gap', 'patrol', 'crumble'],
    ruins: ['moving', 'switch', 'steps', 'gap', 'crumble'],
    cave: ['vent', 'crumble', 'gap', 'steps', 'patrol'],
    snow: ['ice', 'spring', 'gap', 'moving', 'patrol'],
  }[biome.id];
  const l: Level = {
    seed: seed >>> 0,
    index: safeIndex,
    biome: biome.id,
    name: biome.name,
    hint: biome.hint,
    end: 3880,
    goal: 3760,
    gaps: [],
    spikes: [],
    platforms: [],
    springs: [],
    ice: [],
    vents: [],
    gates: [],
    checkpoints: [1620, 2580],
    enemies: [{ x: 490, kind: biome.id === 'snow' ? 'boar' : 'spike', range: 65 }],
    treats: [{ x: 300, y: 30 }],
    chunks: [],
  };
  const platform = (
    x: number,
    y: number,
    width: number,
    kind: Platform['kind'] = 'stone',
    travel = 0,
  ) =>
    l.platforms.push({
      id: l.platforms.length,
      x,
      y,
      width,
      kind,
      travel,
      phase: random() * Math.PI * 2,
    });
  for (let i = 0; i < 6; i++) {
    const x = 650 + i * 480;
    // First two chunks teach the biome's signature mechanics; later chunks are sampled.
    const kind = i < 2 ? options[i] : options[Math.floor(random() * options.length)];
    l.chunks.push({ x, kind });
    if (kind === 'gap') {
      const width = 110 + Math.floor(random() * 26);
      l.gaps.push({ x: x + 210, width });
      l.treats.push({ x: x + 250, y: 95 });
    } else if (kind === 'spring') {
      l.springs.push(x + 150);
      l.gaps.push({ x: x + 225, width: 160 });
      l.treats.push({ x: x + 280, y: 180 });
    } else if (kind === 'moving') {
      platform(x + 170, 65, 130, 'moving', 65);
      platform(x + 345, 125, 110);
      l.spikes.push({ x: x + 250, width: 45 });
      l.treats.push({ x: x + 380, y: 155 });
    } else if (kind === 'switch') {
      l.gates.push({ id: l.gates.length, x: x + 330, switchX: x + 240 });
      l.treats.push({ x: x + 380, y: 35 });
    } else if (kind === 'vent') {
      l.vents.push({ x: x + 220, phase: random() * 3.6 });
      platform(x + 150, 90, 170);
      l.treats.push({ x: x + 235, y: 125 });
    } else if (kind === 'ice') {
      l.ice.push({ x: x + 70, width: 340 });
      l.spikes.push({ x: x + 250, width: 45 });
      l.treats.push({ x: x + 270, y: 105 });
    } else if (kind === 'crumble') {
      platform(x + 115, 60, 120, 'crumble');
      platform(x + 280, 115, 120, 'crumble');
      l.treats.push({ x: x + 335, y: 150 });
    } else if (kind === 'steps') {
      platform(x + 100, 60, 120);
      platform(x + 270, 120, 120);
      l.spikes.push({ x: x + 240, width: 45 });
      l.treats.push({ x: x + 330, y: 155 });
    }
    const enemyKinds: EnemyKind[] =
      biome.id === 'forest'
        ? ['spike', 'hopper']
        : biome.id === 'ruins'
          ? ['hopper', 'spike']
          : biome.id === 'cave'
            ? ['bat', 'hopper']
            : ['boar', 'bat'];
    // Enemy patrols are wholly inside their safe approach zone, away from pits/checkpoints.
    const enemyKind = enemyKinds[Math.floor(random() * enemyKinds.length)];
    l.enemies.push({
      x: x + (enemyKind === 'boar' ? 100 : 80),
      range: enemyKind === 'boar' ? 40 : 20,
      kind: enemyKind,
    });
    l.treats.push({ x: x + 430, y: 30 });
  }
  return l;
}
export function platformPosition(p: Platform, elapsed: number) {
  return {
    ...p,
    x: p.x + (p.kind === 'moving' ? Math.sin(elapsed * 1.5 + (p.phase ?? 0)) * (p.travel ?? 0) : 0),
  };
}
export function ventPhase(elapsed: number, phase: number): 'quiet' | 'warning' | 'active' {
  const t = (elapsed + phase) % 3.6;
  return t < 1.9 ? 'quiet' : t < 2.5 ? 'warning' : 'active';
}
export function groundSegments(level: Level) {
  let start = 0;
  const segments: { x: number; end: number }[] = [];
  for (const gap of level.gaps) {
    segments.push({ x: start, end: gap.x });
    start = gap.x + gap.width;
  }
  segments.push({ x: start, end: level.end });
  return segments;
}
