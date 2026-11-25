import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

const isPreviewHost = /(^|\.)ais-(dev|pre)-/.test(window.location.hostname);

async function purgePreviewServiceWorkers() {
  let hadRegistrations = false;
  if ('serviceWorker' in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      if (regs.length > 0) {
        hadRegistrations = true;
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch {
      // Ignore SW cleanup errors in restricted contexts
    }
  }
  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      // Ignore cache storage errors
    }
  }
  if (
    hadRegistrations &&
    'serviceWorker' in navigator &&
    navigator.serviceWorker.controller &&
    !window.location.search.includes('sw_cleared=1')
  ) {
    const sep = window.location.search ? '&' : '?';
    window.location.replace(`${window.location.pathname}${window.location.search}${sep}sw_cleared=1`);
  }
}

if (isPreviewHost) {
  void purgePreviewServiceWorkers();
} else {
  registerSW({immediate: true});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
