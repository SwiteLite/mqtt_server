import './app.css';
import { mount } from 'svelte';

function ensureAppTarget() {
  let el = document.getElementById('app');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app';
    document.body.appendChild(el);
  }
  return el;
}

function renderFatal(err) {
  const el = ensureAppTarget();
  const msg = err && err.stack ? err.stack : String(err);
  el.innerHTML = `
    <div style="max-width: 900px; margin: 24px auto; padding: 14px; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; background: rgba(255,255,255,0.06);">
      <div style="font-weight: 700; margin-bottom: 8px;">Erreur au démarrage</div>
      <pre style="white-space: pre-wrap; margin: 0; color: rgba(232,238,252,0.9);">${msg}</pre>
      <div style="margin-top: 10px; color: rgba(232,238,252,0.7); font-size: 13px;">
        Ouvre la console (F12) pour plus de détails.
      </div>
    </div>
  `;
}

async function boot() {
  try {
    const { default: App } = await import('./App.svelte');
    // Svelte 5: les composants ne s'instancient plus avec `new`
    return mount(App, { target: ensureAppTarget() });
  } catch (e) {
    console.error('[web] boot error:', e);
    renderFatal(e);
    return null;
  }
}

boot();

