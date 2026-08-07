// The WebView compatibility shim is loaded by index.html as a blocking classic script, so
// that it runs before this bundle exists at all — it is not imported here on purpose.
// See public/compat.js and src/lib/compat.ts.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/app.css';

// A kiosk should never surface browser chrome: block the context menu, pinch-zoom
// gestures and pull-to-refresh, all of which can strand a user on a broken view.
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

/*
 * Register the app-shell worker when served over HTTP. Inside the Capacitor APK the
 * shell already comes from local package assets, and service workers are not available
 * on the file:// origin, so this is skipped there — offline still works either way.
 */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* Non-fatal: documents are cached in IndexedDB regardless. */
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
