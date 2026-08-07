import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { installSameOriginTrustedTypesPolicy } from './security/trustedTypes';
import './ui/styles.css';

installSameOriginTrustedTypesPolicy();

if (window.top !== window.self) {
  document.documentElement.replaceChildren();
  throw new Error('Relayless cannot run inside a third-party frame');
}

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
