// Real snack component in isolation; no terminal/backend claims are made by these tests.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DachsSnackGame } from '../../../src/features/games/DachsGames';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/features/games/games.css';

applyTheme(getCurrentTheme());
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main className="game-terminal">
      <header className="game-terminal-heading">닥스의 간식 타임</header>
      <DachsSnackGame active={true} />
    </main>
  </React.StrictMode>,
);
