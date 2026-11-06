import { VIEW, WORLD } from './content';
import type { ThemeDefinition } from '../../../themes/contract';
import type { SurvivorRun, Point } from './types';

export const REGIONS = [
  { name: '햇살 숲길', subtitle: '꽃밭과 오래된 야영지', accent: 'green' },
  { name: '이끼빛 유적', subtitle: '잊힌 정원의 돌길', accent: 'cyan' },
  { name: '수정 골짜기', subtitle: '보랏빛 광맥과 별무늬 바닥', accent: 'magenta' },
  { name: '눈바람 고개', subtitle: '눈 덮인 전나무와 탐험 흔적', accent: 'blue' },
] as const;

export function regionForStage(stage: number) {
  const chapter = Math.floor((stage - 1) / 3);
  return { ...REGIONS[chapter % REGIONS.length], chapter, biome: chapter % REGIONS.length };
}

/** Coordinate hash: decoration never consumes combat, loot or card random streams. */
export function sceneryHash(seed: number, x: number, y: number) {
  let h = (seed ^ Math.imul(x + 71, 374761393) ^ Math.imul(y + 19, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export function createScenery(seed: number, stage: number) {
  const region = regionForStage(stage);
  const mapSeed = sceneryHash(seed, region.chapter, 907);
  const props: { x: number; y: number; variant: number; scale: number }[] = [];
  for (let y = 0; y < 20; y++)
    for (let x = 0; x < 20; x++) {
      const h = sceneryHash(mapSeed, x, y);
      props.push({
        x: x * 160 + 35 + (h % 90),
        y: y * 160 + 35 + ((h >>> 8) % 90),
        variant: h % 7,
        scale: 0.65 + ((h >>> 16) % 55) / 100,
      });
    }
  // Authored focal points and crossing routes, with bounded seed variation.
  const landmarks = [
    [1320, 1430],
    [1890, 1730],
    [650, 850],
    [2450, 730],
    [900, 2500],
    [2500, 2490],
  ].map(([x, y], i) => {
    const h = sceneryHash(mapSeed, i, 23);
    return { x: x + (h % 101) - 50, y: y + ((h >>> 8) % 101) - 50, variant: i % 3 };
  });
  return { ...region, mapSeed, props, landmarks, bend: (mapSeed % 361) - 180 };
}
type Scenery = ReturnType<typeof createScenery>;
const cache = new WeakMap<SurvivorRun, Scenery>();

function paintScenery(
  ctx: CanvasRenderingContext2D,
  run: SurvivorRun,
  theme: ThemeDefinition,
  cam: Point,
  viewport: { width: number; height: number },
) {
  let map = cache.get(run);
  if (!map || map.chapter !== Math.floor((run.stage.index - 1) / 3)) {
    map = createScenery(run.seed, run.stage.index);
    cache.set(run, map);
  }
  const t = theme.terminal;
  const accent = t[map.accent];
  // Bake opaque inks into the tile. Overlapping branches and crossing paths
  // then retain one silhouette instead of showing the layers underneath.
  const ink = (color: string, percent: number) =>
    `color-mix(in srgb, ${color} ${percent}%, ${t.background})`;
  const visible = (x: number, y: number, margin = 130) =>
    x >= cam.x - margin &&
    x <= cam.x + viewport.width + margin &&
    y >= cam.y - margin &&
    y <= cam.y + viewport.height + margin;
  const oval = (x: number, y: number, rx: number, ry: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  ctx.save();
  ctx.fillStyle = ink(accent, map.biome === 3 ? 9 : 16);
  ctx.fillRect(cam.x, cam.y, viewport.width, viewport.height);
  // Wide, quiet paths establish direction without introducing hidden collision walls.
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let route = 0; route < 3; route++) {
    if (map.biome === 1) {
      if (route === 0) ctx.ellipse(1600, 1600, 360, 240, 0, 0, Math.PI * 2);
      else if (route === 1) {
        ctx.moveTo(0, 1600);
        ctx.lineTo(3200, 1600);
      } else {
        ctx.moveTo(1600, 0);
        ctx.lineTo(1600, 3200);
      }
    } else if (map.biome === 2) {
      ctx.moveTo(route * 850, 0);
      ctx.bezierCurveTo(
        2600 - route * 300,
        1100 + map.bend,
        500 + route * 350,
        1900,
        1100 + route * 950,
        3200,
      );
    } else if (map.biome === 3) {
      ctx.moveTo(0, 600 + route * 900);
      ctx.bezierCurveTo(
        1000,
        300 + route * 900,
        1800,
        1900 + route * 500 + map.bend,
        3200,
        700 + route * 850,
      );
    } else if (route === 0) {
      ctx.moveTo(0, 1100);
      ctx.bezierCurveTo(1100, 2100 + map.bend, 2000, 1050, 3200, 2100);
    } else if (route === 1) {
      ctx.moveTo(1050, 0);
      ctx.bezierCurveTo(2200, 1200, 1100 + map.bend, 1900, 2000, 3200);
    } else {
      ctx.moveTo(0, 2600);
      ctx.bezierCurveTo(1200, 2100, 2200, 2900 + map.bend, 3200, 950);
    }
  }
  const pathColor = [t.yellow, t.brightBlack, t.cyan, t.blue][map.biome];
  ctx.lineWidth = map.biome === 2 ? 38 : 88;
  ctx.strokeStyle = ink(pathColor, 29);
  ctx.stroke();
  ctx.lineWidth -= 4;
  ctx.strokeStyle = ink(pathColor, map.biome === 3 ? 4 : 18);
  ctx.stroke();
  for (
    let gy = Math.floor((cam.y - 64) / 72);
    gy <= Math.ceil((cam.y + viewport.height + 64) / 72);
    gy++
  )
    for (
      let gx = Math.floor((cam.x - 64) / 72);
      gx <= Math.ceil((cam.x + viewport.width + 64) / 72);
      gx++
    ) {
      const h = sceneryHash(map.mapSeed, gx, gy);
      if (h % 5 < 2) continue;
      const x = gx * 72 + (h % 52),
        y = gy * 72 + ((h >>> 8) % 52);
      ctx.globalAlpha = 0.26;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (map.biome === 2) {
        ctx.moveTo(x - 5, y);
        ctx.lineTo(x + 5, y);
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x, y + 5);
      } else if (map.biome === 3) {
        ctx.moveTo(x - 18, y);
        ctx.quadraticCurveTo(x, y - 5, x + 18, y - 2);
        ctx.moveTo(x - 8, y + 5);
        ctx.lineTo(x + 8, y + 3);
      } else if (map.biome === 1) {
        ctx.rect(x - 12, y - 6, 26, 14);
        ctx.moveTo(x + 2, y - 6);
        ctx.lineTo(x + 4, y);
        ctx.lineTo(x - 1, y + 4);
      } else {
        ctx.moveTo(x - 6, y);
        ctx.lineTo(x - 9, y - 5);
        ctx.moveTo(x, y + 1);
        ctx.lineTo(x + 1, y - 8);
        ctx.moveTo(x + 5, y);
        ctx.lineTo(x + 9, y - 4);
      }
      ctx.stroke();
      if (h % 3 === 0) {
        ctx.globalAlpha = 0.35;
        oval(x + 15, y + 9, 2, 1.5, t.foreground);
        oval(x + 20, y + 12, 3, 2, t.foreground);
      }
    }
  // All scenery is ground decoration; attacks and enemies are drawn above it.
  for (const p of map.props) {
    if (!visible(p.x, p.y, 70)) continue;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(p.scale, p.scale);
    ctx.globalAlpha = 1;
    if (p.variant === 1 && map.biome === 0) {
      ctx.fillStyle = ink(t.yellow, 65);
      ctx.fillRect(-3, -10, 6, 25);
      const canopy = ink(t.green, 53);
      oval(-10, -13, 16, 14, canopy);
      oval(12, -13, 14, 13, canopy);
      oval(0, -25, 18, 17, canopy);
      oval(-6, -29, 11, 8, ink(t.green, 40));
    } else if (p.variant < 3 && (map.biome === 0 || map.biome === 3)) {
      const leaf = map.biome === 3 ? t.cyan : t.green;
      ctx.fillStyle = ink(t.yellow, 64);
      ctx.fillRect(-3, 0, 6, 16);
      ctx.beginPath();
      ctx.moveTo(-2, -44);
      ctx.lineTo(14, -20);
      ctx.lineTo(9, -21);
      ctx.lineTo(21, -5);
      ctx.lineTo(15, -6);
      ctx.lineTo(25, 8);
      ctx.quadraticCurveTo(1, 15, -24, 8);
      ctx.lineTo(-15, -7);
      ctx.lineTo(-20, -5);
      ctx.lineTo(-9, -22);
      ctx.lineTo(-14, -19);
      ctx.closePath();
      ctx.fillStyle = ink(leaf, 56);
      ctx.fill();
      ctx.fillStyle = ink(leaf, map.biome === 3 ? 14 : 40);
      ctx.beginPath();
      ctx.moveTo(-2, -44);
      ctx.lineTo(2, -18);
      ctx.lineTo(-4, -21);
      ctx.lineTo(-2, -10);
      ctx.lineTo(-9, -16);
      ctx.lineTo(-20, -5);
      ctx.lineTo(-9, -22);
      ctx.lineTo(-14, -19);
      ctx.closePath();
      ctx.fill();
    } else if (map.biome === 2 && p.variant < 4) {
      for (let i = -1; i <= 1; i++) {
        ctx.fillStyle = ink(i === 0 ? t.magenta : t.cyan, i === 0 ? 52 : 36);
        ctx.beginPath();
        ctx.moveTo(i * 17 - 10, 10);
        ctx.lineTo(i * 17 - 10, -15);
        ctx.lineTo(i * 17, -40 + Math.abs(i) * 15);
        ctx.lineTo(i * 17 + 10, -15);
        ctx.lineTo(i * 17 + 10, 10);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = t.white;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(i * 17, -32 + Math.abs(i) * 15);
        ctx.lineTo(i * 17, 7);
        ctx.stroke();
      }
    } else if (map.biome === 1 || p.variant === 4) {
      ctx.fillStyle = ink(t.brightBlack, 40);
      ctx.beginPath();
      ctx.moveTo(-23, 9);
      ctx.lineTo(-18, -11);
      ctx.lineTo(-6, -19);
      ctx.lineTo(13, -16);
      ctx.lineTo(23, 2);
      ctx.lineTo(14, 12);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = ink(t.brightBlack, 25);
      ctx.beginPath();
      ctx.moveTo(-18, -11);
      ctx.lineTo(-6, -19);
      ctx.lineTo(13, -16);
      ctx.lineTo(4, -6);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = ink(t.foreground, 60);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-16, -9);
      ctx.lineTo(4, -9);
      ctx.lineTo(-2, 5);
      ctx.stroke();
      oval(-14, 11, 12, 4, ink(accent, 54));
    } else {
      for (let i = 0; i < 5; i++) {
        const x = Math.cos(i * 2.4) * 20,
          y = Math.sin(i * 2.4) * 11;
        const petal = ink(p.variant === 5 ? t.yellow : t.magenta, 52);
        oval(x - 2, y, 3, 2, petal);
        oval(x + 2, y, 3, 2, petal);
        oval(x, y - 2, 2, 3, petal);
        oval(x, y, 1.5, 1.5, t.background);
      }
    }
    ctx.restore();
  }
  for (const p of map.landmarks) {
    if (!visible(p.x, p.y, 150)) continue;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = 1;
    oval(0, 4, 80, 42, ink(map.biome === 0 ? t.yellow : accent, 21));
    if (map.biome === 0 || map.biome === 3) {
      // Abandoned camp: log seats, a cold stone firepit and trail marker.
      if (p.variant !== 0) {
        ctx.fillStyle = ink(t.yellow, 58);
        ctx.beginPath();
        ctx.moveTo(-49, -18);
        ctx.lineTo(-28, -50);
        ctx.lineTo(-3, -45);
        ctx.lineTo(14, -15);
        ctx.lineTo(-12, -12);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = ink(t.foreground, 57);
        ctx.beginPath();
        ctx.moveTo(-14, -13);
        ctx.lineTo(-3, -38);
        ctx.lineTo(9, -15);
        ctx.fill();
      }
      ctx.lineWidth = 10;
      ctx.lineCap = 'round';
      ctx.strokeStyle = t.yellow;
      ctx.beginPath();
      ctx.moveTo(-45, -12);
      ctx.lineTo(-35, 18);
      ctx.moveTo(35, -20);
      ctx.lineTo(45, 10);
      ctx.stroke();
      for (let i = 0; i < 8; i++)
        oval(
          Math.cos((i * Math.PI) / 4) * 20,
          Math.sin((i * Math.PI) / 4) * 13,
          5,
          4,
          t.brightBlack,
        );
      ctx.fillStyle = t.yellow;
      ctx.fillRect(50, -66, 4, 38);
      ctx.fillRect(42, -66, 28, 12);
      ctx.strokeStyle = t.foreground;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(48, -60);
      ctx.lineTo(63, -60);
      ctx.stroke();
    } else {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, -29);
      ctx.lineTo(32, 0);
      ctx.lineTo(0, 29);
      ctx.lineTo(-32, 0);
      ctx.closePath();
      ctx.stroke();
      for (const x of [-62, 62]) {
        ctx.fillStyle = t.brightBlack;
        ctx.fillRect(x - 8, -43, 16, 40);
        ctx.fillStyle = accent;
        ctx.fillRect(x - 12, -47, 24, 8);
      }
      oval(0, 0, 9, 6, accent);
    }
    for (let i = 0; i <= p.variant; i++)
      oval(-16 + i * 13, 36 - (i % 2) * 3, 4, 2, ink(t.brightBlack, 46));
    ctx.restore();
  }
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 12;
  ctx.setLineDash([24, 8]);
  ctx.strokeRect(6, 6, WORLD.width - 12, WORLD.height - 12);
  ctx.restore();
}

const TILE = 512;
// At most twelve 512px tiles per live run (12 MiB RGBA), released with its weak key.
const tiles = new WeakMap<
  SurvivorRun,
  { chapter: number; theme: ThemeDefinition; images: Map<string, HTMLCanvasElement> }
>();
export function drawScenery(
  ctx: CanvasRenderingContext2D,
  run: SurvivorRun,
  theme: ThemeDefinition,
  cam: Point,
) {
  const chapter = Math.floor((run.stage.index - 1) / 3);
  let entry = tiles.get(run);
  if (!entry || entry.chapter !== chapter || entry.theme !== theme) {
    entry = { chapter, theme, images: new Map() };
    tiles.set(run, entry);
  }
  for (let y = Math.floor(cam.y / TILE); y <= Math.floor((cam.y + VIEW.height) / TILE); y++)
    for (let x = Math.floor(cam.x / TILE); x <= Math.floor((cam.x + VIEW.width) / TILE); x++) {
      const key = `${x}:${y}`;
      let tile = entry.images.get(key);
      if (!tile) {
        tile = document.createElement('canvas');
        tile.width = tile.height = TILE;
        const paint = tile.getContext('2d')!;
        paint.fillStyle = theme.terminal.background;
        paint.fillRect(0, 0, TILE, TILE);
        paint.translate(-x * TILE, -y * TILE);
        paintScenery(
          paint,
          run,
          theme,
          { x: x * TILE, y: y * TILE },
          { width: TILE, height: TILE },
        );
        if (entry.images.size >= 12) entry.images.delete(entry.images.keys().next().value!);
      } else entry.images.delete(key);
      entry.images.set(key, tile);
      ctx.drawImage(tile, x * TILE, y * TILE);
    }
}
