import React from 'react';
import ReactDOM from 'react-dom/client';
import { DetachedWindow } from './app/DetachedWindow';
import { App } from './app/App';
import './app/styles.css';
import './app/workspace.css';
import { applyTheme } from './themes/adapters/css';
import { getCurrentTheme } from './themes/store';
// Apply persisted tokens before the first React paint, including detached windows.
applyTheme(getCurrentTheme());
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(location.search).get('detached') ? (
      <DetachedWindow id={new URLSearchParams(location.search).get('detached')!} />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
