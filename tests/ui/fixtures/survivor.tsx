// Test-only engine state controls. Never imported from the product entry point.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SurvivorGame } from '../../../src/features/games/survivor/SurvivorGame';
import { SurvivorController } from '../../../src/features/games/survivor/controller';
import {
  browserProfileEnvironment,
  SurvivorProfileStore,
} from '../../../src/features/games/survivor/profileStore';
import { openSurvivorChoice } from '../../../src/features/games/survivor/progression';
import { initialStage } from '../../../src/features/games/survivor/stages';
import { spawnEnemy } from '../../../src/features/games/survivor/enemies';
import { selectTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/features/games/games.css';

declare global {
  interface Window {
    survivorUi: {
      controller: SurvivorController;
      failWrites: boolean;
      cards: (count?: number) => void;
      clear: (stage?: number) => void;
      battle: () => void;
      dark: () => void;
    };
  }
}
const env = browserProfileEnvironment(),
  write = env.storage.setItem;
env.storage.setItem = (key, raw) => {
  if (window.survivorUi.failWrites) throw Error('Fixture write failure');
  write(key, raw);
};
const controller = new SurvivorController(new SurvivorProfileStore(env));
window.survivorUi = {
  controller,
  failWrites: false,
  cards(count = 2) {
    const r = controller.session.run!;
    r.phase = 'choosing';
    r.choice = null;
    r.level = 3;
    r.pendingChoices = count;
    openSurvivorChoice(r);
    controller.session.sync();
    controller.publish();
  },
  clear(stage = 1) {
    const r = controller.session.run!;
    r.phase = 'stageClear';
    r.pendingChoices = 0;
    r.choice = null;
    r.tick = stage * 3600;
    r.stage = initialStage(stage);
    r.stage.waveTicks = 3600;
    r.highestCompletedStage = stage;
    r.highestReachedStage = stage;
    r.bossesDefeated = Math.floor(stage / 3);
    r.bossRewardGold = r.bossesDefeated * 40;
    r.lastRewardedBossStage = r.bossesDefeated * 3;
    r.gold = 25.75;
    controller.session.sync();
    controller.publish();
  },
  battle() {
    const r = controller.session.run!;
    for (const kind of [
      'slime',
      'bat',
      'mushroom',
      'golem',
      'boar',
      'giantSlime',
      'armoredBoar',
      'boss',
    ] as const) {
      const e = spawnEnemy(r, kind);
      if (e) {
        e.x = r.player.x + 140 + (e.id % 3) * 75;
        e.y = r.player.y - 120 + (e.id % 4) * 70;
        if (e.behavior) {
          e.behavior.mode = 'windup';
          e.behavior.action = e.kind === 'boss' ? 'leap' : 'charge';
          e.behavior.target = { x: r.player.x - 130, y: r.player.y };
          e.behavior.direction = { x: -1, y: 0 };
          e.behavior.untilTick = r.tick + 9999;
        }
      }
    }
    r.phase = 'paused';
    r.pausedFrom = 'playing';
    controller.publish();
  },
  dark() {
    selectTheme('github-dark');
  },
};
function Fixture() {
  const [active, setActive] = useState(true),
    [closed, setClosed] = useState(false);
  return (
    <>
      <button onClick={() => setActive((v) => !v)}>테스트 탭 전환</button>
      <button onClick={() => setClosed(controller.close())}>테스트 탭 닫기</button>
      <input aria-label="외부 텍스트 입력" />
      {closed ? (
        <p>탭 닫힘</p>
      ) : (
        <main className="game-terminal" hidden={!active} inert={!active}>
          <SurvivorGame active={active} controller={controller} />
        </main>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
