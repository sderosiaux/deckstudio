/// <reference types="vite/client" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './theme.css';

const root = document.getElementById('root');
if (!root) throw new Error('deckstudio: #root element missing from index.html');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
