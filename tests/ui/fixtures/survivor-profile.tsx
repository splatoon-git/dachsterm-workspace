// Isolated real hub/store, never imported by the production entry point.
import { createRoot } from 'react-dom/client';
import { SurvivorHub } from '../../../src/features/games/survivor/SurvivorHub';
import { PROFILE_KEY, newSurvivorProfile } from '../../../src/features/games/survivor/profile';
import {
  browserProfileEnvironment,
  SurvivorProfileStore,
} from '../../../src/features/games/survivor/profileStore';
import { SurvivorSession } from '../../../src/features/games/survivor/session';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import { getTheme } from '../../../src/themes/registry';
import '../../../src/app/styles.css';
import '../../../src/features/games/games.css';

declare global {
  interface Window {
    survivorTest: { store: SurvivorProfileStore; session: SurvivorSession; failWrites: boolean };
  }
}
const query = new URLSearchParams(location.search);
if (query.has('funded') && !localStorage.getItem(PROFILE_KEY)) {
  const p = newSurvivorProfile();
  p.gold = 2000;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}
const env = browserProfileEnvironment();
const setItem = env.storage.setItem;
env.storage.setItem = (key, raw) => {
  if (window.survivorTest.failWrites)
    throw new DOMException('Fixture quota failure', 'QuotaExceededError');
  setItem(key, raw);
};
if (query.has('noLocks')) env.acquire = null;
const store = new SurvivorProfileStore(env);
const session = new SurvivorSession(store);
window.survivorTest = { store, session, failWrites: false };
void store.connect();
applyTheme(query.has('dark') ? getTheme('github-dark') : getCurrentTheme());
createRoot(document.getElementById('root')!).render(
  <main className="game-terminal">
    <SurvivorHub
      store={store}
      onStart={(revision) => {
        session.start(42, revision);
      }}
      onTemporaryStart={() => {
        session.startTemporary(42);
      }}
    />
  </main>,
);
