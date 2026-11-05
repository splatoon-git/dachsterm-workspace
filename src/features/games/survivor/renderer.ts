import atlasUrl from '../../../assets/brand/dachshund-adventure-atlas.png';
import type { ThemeDefinition } from '../../../themes/contract';
import { ENEMY_RULES, VIEW, WORLD } from './content';
import { survivorCamera } from './geometry';
import type { SurvivorEnemy, SurvivorRun } from './types';

export function loadSurvivorAtlas(redraw: () => void) {
  const image = new Image();
  image.onload = redraw;
  image.src = atlasUrl;
  return image;
}

/** Render-only: no RNG consumption, run mutation, React entities or IPC. */
export function drawSurvivor(
  canvas: HTMLCanvasElement,
  run: SurvivorRun,
  theme: ThemeDefinition,
  atlas: HTMLImageElement,
  reduced: boolean,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = Math.max(1, Math.round(canvas.clientWidth * Math.min(2, devicePixelRatio || 1)));
  const height = Math.round((width * VIEW.height) / VIEW.width);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const t = theme.terminal;
  const cam = survivorCamera(run);
  ctx.setTransform(width / VIEW.width, 0, 0, height / VIEW.height, 0, 0);
  ctx.fillStyle = t.background;
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);
  ctx.save();
  if (!reduced && run.lastDamage && run.tick - run.lastDamage.tick < 10) {
    ctx.translate(Math.sin(run.tick * 3) * 2, Math.cos(run.tick * 2) * 2);
  }
  ctx.translate(-cam.x, -cam.y);
  ctx.lineWidth = 2;
  const circle = (x: number, y: number, r: number, color: string, fill = true) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    if (fill) ctx.fill();
    else ctx.stroke();
  };
  // Sparse deterministic forest marks, based on world cells and seed, never combat RNG.
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = t.green;
  ctx.fillStyle = t.green;
  for (let y = Math.floor(cam.y / 160) * 160; y < cam.y + VIEW.height + 160; y += 160) {
    for (let x = Math.floor(cam.x / 160) * 160; x < cam.x + VIEW.width + 160; x += 160) {
      const h = (Math.imul(x + 17, 73856093) ^ Math.imul(y + 11, 19349663) ^ run.seed) >>> 0;
      const px = x + (h % 100),
        py = y + ((h >>> 8) % 100);
      ctx.beginPath();
      ctx.moveTo(px - 6, py + 9);
      ctx.lineTo(px, py - 8);
      ctx.lineTo(px + 5, py + 9);
      ctx.stroke();
      if (h % 3 === 0) circle(px + 40, py + 30, 6, t.green, false);
    }
  }
  ctx.restore();
  ctx.strokeStyle = t.foreground;
  ctx.lineWidth = 8;
  ctx.strokeRect(2, 2, WORLD.width - 4, WORLD.height - 4);
  ctx.lineWidth = 2;
  for (const drop of run.drops) {
    if (
      drop.x < cam.x - 12 ||
      drop.x > cam.x + VIEW.width + 12 ||
      drop.y < cam.y - 12 ||
      drop.y > cam.y + VIEW.height + 12
    )
      continue;
    if (drop.kind === 'xp') {
      ctx.fillStyle = t.cyan;
      ctx.beginPath();
      ctx.moveTo(drop.x, drop.y - 6);
      ctx.lineTo(drop.x + 5, drop.y);
      ctx.lineTo(drop.x, drop.y + 6);
      ctx.lineTo(drop.x - 5, drop.y);
      ctx.fill();
    } else if (drop.kind === 'gold') {
      circle(drop.x, drop.y, 7, t.yellow);
      ctx.strokeStyle = t.background;
      ctx.beginPath();
      ctx.moveTo(drop.x, drop.y - 4);
      ctx.lineTo(drop.x, drop.y + 4);
      ctx.stroke();
    } else {
      ctx.fillStyle = t.green;
      ctx.fillRect(drop.x - 8, drop.y - 8, 16, 16);
      ctx.strokeStyle = t.background;
      ctx.beginPath();
      ctx.moveTo(drop.x - 5, drop.y);
      ctx.lineTo(drop.x + 5, drop.y);
      ctx.moveTo(drop.x, drop.y - 5);
      ctx.lineTo(drop.x, drop.y + 5);
      ctx.stroke();
    }
  }
  for (const attack of run.attacks) {
    ctx.save();
    if (attack.kind === 'trail') {
      ctx.globalAlpha = 0.2;
      circle(attack.x, attack.y, attack.radius, t.blue);
      ctx.globalAlpha = 0.8;
      circle(attack.x, attack.y, attack.radius, t.blue, false);
    }
    if (attack.kind === 'wave' && !attack.waiting) {
      ctx.lineWidth = 4;
      circle(attack.x, attack.y, attack.radius, t.cyan, false);
    }
    if (attack.kind === 'acorn') {
      ctx.setLineDash(attack.exploded ? [] : [7, 5]);
      ctx.lineWidth = 3;
      circle(attack.x, attack.y, attack.radius, t.yellow, false);
      if (attack.exploded) {
        ctx.globalAlpha = 0.25;
        circle(attack.x, attack.y, attack.radius, t.yellow);
      } else {
        ctx.fillStyle = t.yellow;
        ctx.font = 'bold 22px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('↓', attack.x, attack.y + 6);
      }
    }
    if (attack.kind === 'orbit') {
      circle(attack.x, attack.y, attack.radius, t.blue);
      circle(attack.x, attack.y, 5, t.background);
    }
    if (attack.kind === 'boomerang' && attack.leg !== 'waiting') {
      ctx.translate(attack.x, attack.y);
      ctx.rotate(reduced ? 0 : run.tick * 0.22);
      ctx.strokeStyle = t.yellow;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(-10, 0);
      ctx.lineTo(10, 0);
      ctx.stroke();
      circle(-10, -3, 5, t.yellow);
      circle(10, 3, 5, t.yellow);
    }
    ctx.restore();
  }
  for (const enemy of run.enemies) {
    const ai = enemy.behavior;
    if (ai?.mode !== 'windup') continue;
    ctx.save();
    ctx.strokeStyle = t.red;
    ctx.fillStyle = t.red;
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 5]);
    if (ai.action === 'leap') {
      const radius =
        enemy.kind === 'boss' ? ENEMY_RULES.boss.leapRadius : ENEMY_RULES.giantSlime.radius;
      circle(ai.target.x, ai.target.y, radius, t.red, false);
      ctx.beginPath();
      ctx.moveTo(ai.target.x - 10, ai.target.y);
      ctx.lineTo(ai.target.x + 10, ai.target.y);
      ctx.moveTo(ai.target.x, ai.target.y - 10);
      ctx.lineTo(ai.target.x, ai.target.y + 10);
      ctx.stroke();
    } else {
      ctx.translate(enemy.x, enemy.y);
      ctx.rotate(Math.atan2(ai.direction.y, ai.direction.x));
      if (ai.action === 'charge') {
        const rules = enemy.kind === 'armoredBoar' ? ENEMY_RULES.armoredBoar : ENEMY_RULES.boar;
        const distance =
          enemy.kind === 'boss'
            ? ((ENEMY_RULES.boss.chargeSpeed * ENEMY_RULES.boss.charge) / 60) *
              (run.stage.bossTicks >= ENEMY_RULES.boss.enrageTick ? 1.15 : 1)
            : (rules.speed * rules.charge) / 60;
        ctx.strokeRect(0, -enemy.radius, distance, enemy.radius * 2);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(distance, 0);
        ctx.lineTo(distance - 15, -12);
        ctx.moveTo(distance, 0);
        ctx.lineTo(distance - 15, 12);
        ctx.stroke();
      } else if (enemy.kind === 'boss') {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, 240, -Math.PI / 3, Math.PI / 3);
        ctx.closePath();
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(300, 0);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  const enemyShape = (e: SurvivorEnemy) => {
    const { x, y, radius: r, kind } = e;
    ctx.save();
    ctx.translate(x, y);
    ctx.lineWidth = kind === 'boss' ? 4 : 2;
    ctx.fillStyle =
      kind === 'slime' || kind === 'giantSlime'
        ? t.green
        : kind === 'bat'
          ? t.magenta
          : kind === 'mushroom'
            ? t.red
            : kind === 'golem'
              ? t.brightBlack
              : t.yellow;
    ctx.strokeStyle = t.foreground;
    ctx.beginPath();
    if (kind === 'bat') {
      ctx.moveTo(-r * 1.6, -r);
      ctx.lineTo(-r * 0.4, 0);
      ctx.lineTo(0, -r);
      ctx.lineTo(r * 0.4, 0);
      ctx.lineTo(r * 1.6, -r);
      ctx.lineTo(r, r);
      ctx.lineTo(-r, r);
    } else if (kind === 'golem' || kind === 'armoredBoar') ctx.rect(-r, -r, r * 2, r * 2);
    else if (kind === 'mushroom') {
      ctx.arc(0, 0, r, Math.PI, 0);
      ctx.lineTo(r * 0.35, r);
      ctx.lineTo(-r * 0.35, r);
    } else ctx.ellipse(0, 0, r, r * 0.85, 0, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (kind === 'boss' || kind === 'boar' || kind === 'armoredBoar') {
      ctx.beginPath();
      ctx.moveTo(-r * 0.8, -r * 0.2);
      ctx.lineTo(-r, -r * 1.2);
      ctx.lineTo(-r * 0.3, -r * 0.65);
      ctx.moveTo(r * 0.8, -r * 0.2);
      ctx.lineTo(r, -r * 1.2);
      ctx.lineTo(r * 0.3, -r * 0.65);
      ctx.stroke();
    }
    ctx.fillStyle = t.background;
    ctx.fillRect(-r * 0.5, -4, r * 0.3, 5);
    ctx.fillRect(r * 0.2, -4, r * 0.3, 5);
    if (e.hp < e.maxHp || ['boss', 'giantSlime', 'armoredBoar'].includes(kind)) {
      ctx.fillStyle = t.foreground;
      ctx.fillRect(-r, r + 8, r * 2, 5);
      ctx.fillStyle = t.red;
      ctx.fillRect(-r, r + 8, (r * 2 * e.hp) / e.maxHp, 5);
    }
    ctx.restore();
  };
  for (const enemy of run.enemies) {
    if (
      enemy.x >= cam.x - 120 &&
      enemy.x <= cam.x + VIEW.width + 120 &&
      enemy.y >= cam.y - 120 &&
      enemy.y <= cam.y + VIEW.height + 120
    )
      enemyShape(enemy);
  }
  for (const p of run.enemyProjectiles) {
    circle(p.x, p.y, p.radius + 2, t.background);
    circle(p.x, p.y, p.radius, t.red);
  }
  const bite = run.bite.lastAttack;
  if (bite && run.tick - bite.tick < 10) {
    const angle = Math.atan2(bite.direction.y, bite.direction.x);
    ctx.save();
    ctx.strokeStyle = t.blue;
    ctx.fillStyle = t.blue;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(bite.origin.x, bite.origin.y);
    ctx.arc(
      bite.origin.x,
      bite.origin.y,
      bite.radius,
      angle - bite.halfAngle,
      angle + bite.halfAngle,
    );
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 0.15;
    ctx.fill();
    ctx.restore();
  }
  const p = run.player;
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = t.foreground;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + 13, 34, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (run.tick < p.invulnerableUntilTick) {
    ctx.lineWidth = 3;
    circle(p.x, p.y, p.radius + 5, t.red, false);
  }
  const hurt = run.lastDamage && run.tick - run.lastDamage.tick < 15;
  const frame = hurt
    ? 5
    : bite && run.tick - bite.tick < 10
      ? 4
      : reduced
        ? 0
        : 1 + (Math.floor(run.tick / 10) % 2);
  if (atlas.complete && atlas.naturalWidth) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(p.facing.x < 0 ? -1 : 1, 1);
    ctx.drawImage(
      atlas,
      (frame % 3) * 512,
      Math.floor(frame / 3) * 512,
      512,
      512,
      -46,
      -65,
      92,
      92,
    );
    ctx.restore();
  } else {
    circle(p.x, p.y, p.radius, t.blue);
  }
  ctx.restore();
  const boss = run.enemies.find((e) => e.kind === 'boss');
  if (
    boss &&
    (boss.x < cam.x ||
      boss.x > cam.x + VIEW.width ||
      boss.y < cam.y ||
      boss.y > cam.y + VIEW.height)
  ) {
    const x = Math.max(55, Math.min(VIEW.width - 55, boss.x - cam.x));
    const y = Math.max(30, Math.min(VIEW.height - 30, boss.y - cam.y));
    ctx.fillStyle = t.red;
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('◆ 보스', x, y);
  }
}
