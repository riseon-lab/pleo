// App shell: boot/auth gate, router, sidebar.
import { api, setToken, getToken, setUnauthorizedHandler, connectEvents, disconnectEvents } from './api.js';
import * as cryp from './crypto.js';
import { getUI, saveUI } from './state.js';
import { h, clear, toast } from './ui.js';
import * as running from './views/running.js';
import * as models from './views/models.js';
import * as assets from './views/assets.js';
import * as loras from './views/loras.js';
import * as settings from './views/settings.js';
import * as datastudio from './views/datastudio.js';
import * as training from './views/training.js';

const ICONS = {
  running: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
  models: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  assets: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  loras: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
  data: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  training: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  settings: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

const ROUTES = [
  { path: 'running', label: 'Running', icon: 'running', view: running },
  { path: 'models', label: 'Models', icon: 'models', view: models },
  { path: 'assets', label: 'Assets', icon: 'assets', view: assets },
  { path: 'loras', label: 'LoRAs', icon: 'loras', view: loras },
  { path: 'data-studio', label: 'Data Studio', icon: 'data', view: datastudio },
  { path: 'training', label: 'Training', icon: 'training', view: training },
];

const bootEl = document.getElementById('boot');
const bootBody = document.getElementById('boot-body');
const appEl = document.getElementById('app');

setUnauthorizedHandler(() => {
  setToken(null);
  disconnectEvents();
  showLoginGate();
});

// ---------------- Auth gate ----------------

async function boot() {
  try {
    const meta = await (await fetch('/api/auth/meta')).json();
    if (!meta.exists) return showSignup();
    const hasStoredKey = await cryp.loadStoredKey();
    if (getToken() && hasStoredKey) {
      try {
        await api('/api/settings/status');
        return enterApp();
      } catch { /* stale token */ }
    }
    showLogin(meta);
  } catch (e) {
    clear(bootBody).append(
      h('p', { class: 'muted' }, `Cannot reach the backend (${e.message}). Retrying…`));
    setTimeout(boot, 2000);
  }
}

function showLoginGate() {
  appEl.hidden = true;
  bootEl.style.display = 'flex';
  boot();
}

function authForm({ title, hint, confirm, onSubmit }) {
  const pass = h('input', { type: 'password', placeholder: 'Password', autocomplete: confirm ? 'new-password' : 'current-password' });
  const pass2 = confirm ? h('input', { type: 'password', placeholder: 'Confirm password', autocomplete: 'new-password' }) : null;
  const err = h('p', { class: 'muted', style: 'color:var(--danger);min-height:1.2em', role: 'alert' });
  const btn = h('button', { class: 'btn', style: 'width:100%' }, title);
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!pass.value) return;
      if (confirm && pass.value.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
      if (confirm && pass.value !== pass2.value) { err.textContent = 'Passwords do not match.'; return; }
      btn.disabled = true;
      btn.textContent = 'Deriving key…';
      try { await onSubmit(pass.value); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = title; }
    },
  },
    h('p', { class: 'muted' }, hint),
    h('label', { class: 'field' }, pass),
    confirm ? h('label', { class: 'field' }, pass2) : null,
    err, btn);
  clear(bootBody).append(form);
  pass.focus();
}

function showSignup() {
  authForm({
    title: 'Create account',
    confirm: true,
    hint: 'First boot. Your password derives the key that encrypts everything — it is never sent to the server and cannot be recovered.',
    onSubmit: async (password) => {
      const salt = cryp.randomSaltB64();
      const iterations = 600000;
      const authKey = await cryp.deriveAndActivate(password, salt, iterations);
      const res = await api('/api/auth/signup', { method: 'POST', body: { salt, iterations, auth_key: authKey } });
      setToken(res.token);
      enterApp();
    },
  });
}

function showLogin(meta) {
  authForm({
    title: 'Unlock',
    confirm: false,
    hint: 'Enter your password to decrypt your workspace.',
    onSubmit: async (password) => {
      const authKey = await cryp.deriveAndActivate(password, meta.salt, meta.iterations);
      const res = await api('/api/auth/login', { method: 'POST', body: { auth_key: authKey } });
      setToken(res.token);
      enterApp();
    },
  });
}

// ---------------- Shell ----------------

let currentPath = null;
let currentCleanup = null;

function enterApp() {
  bootEl.style.display = 'none';
  appEl.hidden = false;
  connectEvents();
  buildSidebar();
  if (getUI().collapsed) appEl.classList.add('collapsed');
  window.addEventListener('hashchange', route);
  route();
}

function buildSidebar() {
  const nav = clear(document.getElementById('side-nav'));
  for (const r of ROUTES) {
    const item = h('button', { class: 'nav-item', dataset: { path: r.path }, onclick: () => { location.hash = `#/${r.path}`; } });
    item.insertAdjacentHTML('beforeend', ICONS[r.icon]);
    item.append(h('span', { class: 'nav-label' }, r.label));
    nav.append(item);
  }
  const foot = clear(document.getElementById('side-foot'));
  const sItem = h('button', { class: 'nav-item', dataset: { path: 'settings' }, onclick: () => { location.hash = '#/settings'; } });
  sItem.insertAdjacentHTML('beforeend', ICONS.settings);
  sItem.append(h('span', { class: 'nav-label' }, 'Settings'));
  foot.append(sItem);
  document.getElementById('collapse-btn').onclick = () => {
    const collapsed = appEl.classList.toggle('collapsed');
    saveUI({ collapsed });
  };
}

async function route() {
  const path = (location.hash.replace(/^#\//, '') || getUI().route || 'running').split('?')[0];
  const entry = path === 'settings'
    ? { path: 'settings', view: settings }
    : ROUTES.find(r => r.path === path) || ROUTES[0];
  if (currentPath === entry.path) return;
  if (currentCleanup) { try { currentCleanup(); } catch { } currentCleanup = null; }
  currentPath = entry.path;
  saveUI({ route: entry.path });
  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.path === entry.path));
  const view = clear(document.getElementById('view'));
  try {
    currentCleanup = await entry.view.render(view, entry.planned) || null;
  } catch (e) {
    console.error(e);
    view.append(h('div', { class: 'card' }, h('h2', {}, 'Something went wrong'), h('p', { class: 'muted' }, e.message)));
    toast(e.message, 'error');
  }
}

export function logoutAndReload() {
  api('/api/auth/logout', { method: 'POST' }).catch(() => { });
  setToken(null);
  cryp.clearKey().finally(() => location.reload());
}

boot();
