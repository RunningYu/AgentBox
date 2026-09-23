import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { QuickPalette } from './features/quick-palette/QuickPalette';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).has('quick-palette') ? <QuickPalette /> : <App />}
  </React.StrictMode>,
);
