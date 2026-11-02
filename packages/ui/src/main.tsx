import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/tokens.css';
import './styles/primitives.css';
import './styles/app.css';
import './styles/timeline.css';
import './styles/modals.css';
import './styles/inspector.css';
import './styles/canvas.css';

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
