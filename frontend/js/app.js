// App shell: boot/auth gate, router, sidebar.
import { api, setToken, getToken, setUnauthorizedHandler, connectEvents, disconnectEvents } from './api.js';
import * as cryp from './crypto.js';
import { getUI, saveUI } from './state.js';
import { h, clear, toast } from './ui.js';
import { icon } from './studio/icons.js';
import * as running from './views/running.js';
import * as models from './views/models.js';
import * as assets from './views/assets.js';
import * as loras from './views/loras.js';
import * as settings from './views/settings.js';
import * as datastudio from './views/datastudio.js';
import * as training from './views/training.js';

const ROUTES = [
  { path: 'running', label: 'Create', icon: 'running', view: running },
  { path: 'models', label: 'Models', icon: 'models', view: models },
  { path: 'assets', label: 'Library', icon: 'assets', view: assets },
  { path: 'loras', label: 'LoRA library', icon: 'loras', view: loras },
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
    item.append(icon({ running: 'sparkles', models: 'box', assets: 'photo', loras: 'adjustments', data: 'database', training: 'school' }[r.icon]));
    item.append(h('span', { class: 'nav-label' }, r.label));
    nav.append(item);
  }
  const foot = clear(document.getElementById('side-foot'));
  const sItem = h('button', { class: 'nav-item', 'aria-label': 'Settings', dataset: { path: 'settings' }, onclick: () => { location.hash = '#/settings'; } });
  sItem.append(icon('settings'));
  sItem.append(h('span', { class: 'nav-label' }, 'Settings'));
  foot.append(sItem);
  document.getElementById('collapse-btn').onclick = () => {
    const expanded = appEl.classList.toggle('nav-open');
    document.getElementById('collapse-btn').setAttribute('aria-expanded', String(expanded));
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
  appEl.classList.remove('nav-open');
  document.getElementById('collapse-btn').setAttribute('aria-expanded', 'false');
  viewType(entry.path);
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

function viewType(path) { document.body.classList.toggle('is-studio', path === 'running'); }

export function logoutAndReload() {
  api('/api/auth/logout', { method: 'POST' }).catch(() => { });
  setToken(null);
  cryp.clearKey().finally(() => location.reload());
}

boot();
