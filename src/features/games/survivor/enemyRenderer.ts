import { canvasFont } from './canvasFont';
import type { ThemeDefinition } from '../../../themes/contract';
import type { SurvivorEnemy, SurvivorRun } from './types';

/** Small vector characters: shared palette, distinct silhouettes and action poses. */
function paintEnemyBody(
  ctx: CanvasRenderingContext2D,
  e: SurvivorEnemy,
  run: SurvivorRun,
  theme: ThemeDefinition,
  phase: number,
) {
  const t = theme.terminal;
  const r = e.radius,
    kind = e.kind;
  const elite = kind === 'giantSlime' || kind === 'armoredBoar' || kind === 'boss';
  const bob = Math.sin(phase);
  const windup = e.behavior?.mode === 'windup';
  const charge = e.behavior?.mode === 'charge';
  const oval = (x: number, y: number, rx: number, ry: number, color: string, outline = false) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    if (outline) ctx.stroke();
  };
  const line = (points: number[], color: string, width = 2) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
    ctx.stroke();
    ctx.strokeStyle = t.foreground;
    ctx.lineWidth = 1.5;
  };
  const eyes = (y: number, spread = 0.32) => {
    const dx = Math.sign(run.player.x - e.x) * 1.5;
    for (const side of [-1, 1]) {
      oval(side * r * spread, y, r * 0.13 + 1, r * 0.17 + 1, t.white);
      oval(side * r * spread + dx, y + 1, r * 0.065 + 1, r * 0.1 + 1, t.black);
      if (windup)
        line([side * r * spread - 5, y - 7, side * r * spread + 5, y - 4], t.foreground, 2.5);
    }
  };
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.18;
  oval(2, r * 0.68, r * 0.95, r * 0.3, t.foreground);
  ctx.globalAlpha = 1;
  if (elite) {
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = t.yellow;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.ellipse(0, r * 0.65, r + 8, r * 0.4, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  ctx.save();
  ctx.strokeStyle = t.foreground;
  ctx.lineWidth = 1.5;
  if (kind === 'slime' || kind === 'giantSlime') {
    ctx.translate(0, -Math.max(0, bob) * 3);
    ctx.scale(1 + bob * 0.055, windup ? 0.8 : 1 - bob * 0.055);
    const color = e.id % 3 === 0 ? t.cyan : t.green;
    oval(-r * 0.55, r * 0.47, r * 0.45, r * 0.25, color, true);
    oval(r * 0.55, r * 0.47, r * 0.45, r * 0.25, color, true);
    oval(0, 0, r, r * 0.82, color, true);
    ctx.globalAlpha = 0.35;
    oval(-r * 0.4, -r * 0.4, r * 0.27, r * 0.14, t.white);
    ctx.globalAlpha = 1;
    eyes(0);
    line([-4, r * 0.3, 0, r * 0.37, 4, r * 0.3], t.foreground);
    if (elite) {
      ctx.fillStyle = t.yellow;
      ctx.beginPath();
      ctx.moveTo(-20, -r * 0.6);
      ctx.lineTo(-24, -r - 10);
      ctx.lineTo(-8, -r);
      ctx.lineTo(0, -r - 19);
      ctx.lineTo(8, -r);
      ctx.lineTo(24, -r - 10);
      ctx.lineTo(20, -r * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      oval(0, -r, 4, 4, t.red);
    }
  } else if (kind === 'bat') {
    ctx.translate(0, -5 + bob * 2);
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.scale(side, 1);
      ctx.fillStyle = t.magenta;
      ctx.beginPath();
      ctx.moveTo(3, -4);
      ctx.quadraticCurveTo(19, -12 - bob * 8, 30, -18 - bob * 8);
      ctx.lineTo(27, 3);
      ctx.quadraticCurveTo(18, -4, 16, 9);
      ctx.quadraticCurveTo(10, 2, 5, 11);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      line([7, -2, 23, -10 - bob * 5, 17, 5], t.brightMagenta, 1.5);
      ctx.restore();
    }
    oval(0, 1, 9, 12, t.magenta, true);
    line([-7, -5, -6, -16, 0, -8, 6, -16, 7, -5], t.foreground);
    eyes(0, 0.28);
    line([-3, 8, -2, 11, 0, 8, 2, 11, 3, 8], t.white, 1.5);
  } else if (kind === 'mushroom') {
    oval(-8, 14, 7, 4, t.yellow, true);
    oval(8, 14, 7, 4, t.yellow, true);
    oval(0, 5, 11, 13, t.yellow, true);
    ctx.translate(0, windup ? -2 : bob);
    ctx.fillStyle = e.id % 2 ? t.red : t.magenta;
    ctx.beginPath();
    ctx.moveTo(-r - 3, -1);
    ctx.bezierCurveTo(-r - 2, -r * 1.6, r + 2, -r * 1.6, r + 3, -1);
    ctx.quadraticCurveTo(0, 9, -r - 3, -1);
    ctx.fill();
    ctx.stroke();
    oval(-9, -12, 4, 3, t.white);
    oval(5, -18, 5, 3, t.white);
    oval(13, -7, 3, 2, t.white);
    eyes(7, 0.24);
    if (windup) oval(0, 13, 4, 3, t.black);
  } else if (kind === 'golem') {
    for (const side of [-1, 1]) {
      oval(side * 13, 20 + side * bob * 2, 11, 8, t.brightBlack, true);
      oval(side * 26, 2 - side * bob * 3, 10, 16, t.brightBlack, true);
    }
    ctx.fillStyle = t.brightBlack;
    ctx.beginPath();
    ctx.moveTo(-20, 15);
    ctx.lineTo(-24, -14);
    ctx.lineTo(-12, -28);
    ctx.lineTo(16, -25);
    ctx.lineTo(24, -8);
    ctx.lineTo(18, 18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    line([-12, -24, -4, -9, -10, 2, 2, 15], t.foreground);
    ctx.globalAlpha = 0.6;
    oval(-14, -20, 10, 4, t.green);
    ctx.globalAlpha = 1;
    eyes(-6, 0.36);
    oval(0, 8, 4, 5, t.cyan);
  } else {
    const boss = kind === 'boss',
      armor = kind === 'armoredBoar' || boss;
    ctx.scale(run.player.x < e.x ? -1 : 1, 1);
    ctx.rotate(charge ? -0.08 : 0);
    const coat = boss ? t.green : t.yellow;
    for (const side of [-1, 1]) {
      oval(side * r * 0.5, r * 0.62 + bob * side * 2, r * 0.2, r * 0.24, t.brightBlack, true);
    }
    oval(-r * 0.1, 0, r, r * 0.75, coat, true);
    line([-r * 0.85, -r * 0.25, -r * 1.2, -r * 0.55, -r * 1.3, -r * 0.2], coat, 4);
    if (armor) {
      ctx.fillStyle = boss ? t.cyan : t.brightBlack;
      ctx.beginPath();
      ctx.moveTo(-r, -r * 0.4);
      ctx.lineTo(-r * 0.55, -r);
      ctx.lineTo(r * 0.3, -r * 0.85);
      ctx.lineTo(r * 0.5, -r * 0.1);
      ctx.lineTo(-r * 0.7, r * 0.25);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      for (let i = 0; i < 3; i++) oval(-r * 0.65 + i * r * 0.3, -r * 0.4, 2.5, 2.5, t.yellow);
    }
    oval(r * 0.48, -r * 0.06, r * 0.62, r * 0.6, coat, true);
    ctx.fillStyle = coat;
    ctx.beginPath();
    ctx.moveTo(r * 0.2, -r * 0.4);
    ctx.lineTo(r * 0.12, -r);
    ctx.lineTo(r * 0.62, -r * 0.55);
    ctx.fill();
    ctx.stroke();
    oval(r * 0.94, r * 0.16, r * 0.32, r * 0.24, t.red, true);
    oval(r * 1.04, r * 0.12, 2, 3, t.black);
    oval(r * 0.65, -r * 0.2, r * 0.1 + 1, r * 0.13 + 1, t.white);
    oval(r * 0.69, -r * 0.18, 2, 3, t.black);
    line([r * 0.69, r * 0.32, r * 0.82, r * 0.42, r * 0.9, -r * 0.03], t.white, boss ? 5 : 3);
    if (boss) {
      for (const side of [-1, 1])
        line(
          [
            side * r * 0.35,
            -r * 0.55,
            side * r * 0.5,
            -r * 1.15,
            side * r * 0.82,
            -r * 1.4,
            side * r * 0.65,
            -r * 1.1,
            side * r * 0.95,
            -r * 1.12,
          ],
          t.yellow,
          5,
        );
      oval(-r * 0.2, -r * 0.7, 6, 9, t.yellow, true);
    }
    if (windup) line([r * 0.46, -r * 0.4, r * 0.78, -r * 0.3], t.foreground, 3);
  }
  ctx.restore();
  if (windup) {
    ctx.fillStyle = t.red;
    ctx.font = canvasFont(theme, 'large', true);
    ctx.textAlign = 'center';
    ctx.fillText('!', 0, -r - (elite ? 22 : 12));
  }
  ctx.restore();
}

// Bounded, theme-local sprite atlas. Health bars stay live and are never cached.
const sprites = new Map<string, HTMLCanvasElement>();
let spriteTheme: ThemeDefinition | undefined;
let spritePixels = 0;
const PIXEL_BUDGET = 4 * 1024 * 1024;
export function drawSurvivorEnemy(
  ctx: CanvasRenderingContext2D,
  e: SurvivorEnemy,
  run: SurvivorRun,
  theme: ThemeDefinition,
  reduced: boolean,
) {
  if (spriteTheme !== theme) {
    sprites.clear();
    spritePixels = 0;
    spriteTheme = theme;
  }
  const cycle = Math.PI * 2;
  const frame = reduced ? 0 : Math.floor((((run.tick * 0.13 + e.id * 2.4) % cycle) / cycle) * 8);
  const variant =
    e.kind === 'slime' || e.kind === 'giantSlime' ? e.id % 3 : e.kind === 'mushroom' ? e.id % 2 : 0;
  const key = `${e.kind}:${e.radius}:${variant}:${frame}:${e.behavior?.mode ?? 'chase'}:${Math.sign(run.player.x - e.x)}`;
  const extent = Math.ceil(e.radius * 1.65 + 14);
  let sprite = sprites.get(key);
  if (!sprite) {
    sprite = document.createElement('canvas');
    sprite.width = sprite.height = extent * 4;
    const paint = sprite.getContext('2d')!;
    paint.scale(2, 2);
    paint.translate(extent - e.x, extent - e.y);
    paintEnemyBody(paint, e, run, theme, (frame / 8) * cycle);
    while (spritePixels + sprite.width * sprite.height > PIXEL_BUDGET && sprites.size) {
      const oldest = sprites.keys().next().value!;
      const entry = sprites.get(oldest)!;
      spritePixels -= entry.width * entry.height;
      sprites.delete(oldest);
    }
    spritePixels += sprite.width * sprite.height;
  } else sprites.delete(key);
  sprites.set(key, sprite);
  ctx.drawImage(sprite, e.x - extent, e.y - extent, extent * 2, extent * 2);
  const elite = e.kind === 'boss' || e.kind === 'giantSlime' || e.kind === 'armoredBoar';
  if (e.hp < e.maxHp || elite) {
    ctx.fillStyle = theme.terminal.foreground;
    ctx.fillRect(e.x - e.radius, e.y + e.radius + 9, e.radius * 2, 5);
    ctx.fillStyle = elite ? theme.terminal.yellow : theme.terminal.red;
    ctx.fillRect(
      e.x - e.radius + 1,
      e.y + e.radius + 10,
      Math.max(0, ((e.radius * 2 - 2) * e.hp) / e.maxHp),
      3,
    );
  }
}
