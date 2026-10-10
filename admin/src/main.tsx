import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './app.js';
import './styles.css';

const mount = document.getElementById('root');
if (mount === null) throw new Error('Administration mount point is absent.');
createRoot(mount).render(
  <BrowserRouter basename="/admin">
    <App />
  </BrowserRouter>,
);
