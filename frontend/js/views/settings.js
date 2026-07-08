// Settings: encrypted API keys, moderation toggle, git updater, restart, status.
import { api } from '../api.js';
import { encryptJSON, decryptJSON } from '../crypto.js';
import { h, toast, confirmModal } from '../ui.js';

import { logoutAndReload } from '../app.js';

// Decrypted keys cache (memory only — never in storage). Other views use
// getApiKeys() to attach keys transiently to download requests.
let keysCache = null;

export async function getApiKeys() {
  if (keysCache) return keysCache;
  try {
    const { blob } = await api('/api/settings/keys');
    keysCache = blob ? await decryptJSON(blob) : {};
  } catch {
    keysCache = {};
  }
  return keysCache;
}

export async function render(root) {
  const [status, modStatus, keys] = await Promise.all([
    api('/api/settings/status'), api('/api/settings/moderation'), getApiKeys()]);

  // ---- API keys ----
  const hf = h('input', { type: 'password', placeholder: 'hf_…', value: keys.hf_key || '', autocomplete: 'off' });
  const civ = h('input', { type: 'password', placeholder: 'Civitai API key', value: keys.civitai_key || '', autocomplete: 'off' });
  const saveKeys = h('button', {
    class: 'btn', onclick: async () => {
      saveKeys.disabled = true;
      try {
        keysCache = { hf_key: hf.value.trim(), civitai_key: civ.value.trim() };
        await api('/api/settings/keys', { method: 'POST', body: { blob: await encryptJSON(keysCache) } });
        toast('Keys saved (encrypted with your login key)', 'success');
      } catch (e) { toast(e.message, 'error'); }
      saveKeys.disabled = false;
    },
  }, 'Save keys');

  // ---- moderation ----
  const modToggle = h('input', { type: 'checkbox', checked: modStatus.enabled });
  const modDetail = h('p', { class: 'muted' }, moderationDetail(modStatus));
  const installBtn = h('button', {
    class: 'btn ghost small', hidden: modStatus.model_present, onclick: async () => {
      installBtn.disabled = true;
      installBtn.textContent = 'Downloading classifier (~330 MB)…';
      try {
        const keys = await getApiKeys();
        const s = await api('/api/settings/moderation/install', { method: 'POST', body: { hf_key: keys.hf_key || null } });
        modDetail.textContent = moderationDetail(s);
        installBtn.hidden = true;
        toast('Classifier installed', 'success');
      } catch (e) { toast(e.message, 'error'); installBtn.disabled = false; installBtn.textContent = 'Install classifier'; }
    },
  }, 'Install classifier');
  modToggle.onchange = async () => {
    try {
      const s = await api('/api/settings/moderation', { method: 'POST', body: { enabled: modToggle.checked } });
      modDetail.textContent = moderationDetail(s);
      toast(`Moderation ${s.enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (e) { toast(e.message, 'error'); modToggle.checked = !modToggle.checked; }
  };

  // ---- git / restart ----
  const gitOut = h('pre', { class: 'output', hidden: true });
  const gitBtn = h('button', {
    class: 'btn ghost', onclick: async () => {
      gitBtn.disabled = true;
      gitBtn.textContent = 'Pulling…';
      try {
        const r = await api('/api/settings/git-pull', { method: 'POST' });
        gitOut.hidden = false;
        gitOut.textContent = [r.stdout, r.stderr].filter(Boolean).join('\n');
        toast(r.ok ? 'Repo updated' : 'git pull failed', r.ok ? 'success' : 'error');
      } catch (e) { toast(e.message, 'error'); }
      gitBtn.disabled = false;
      gitBtn.textContent = 'Pull latest code';
    },
  }, 'Pull latest code');

  const restartBtn = h('button', {
    class: 'btn ghost', onclick: async () => {
      if (!await confirmModal('Restart backend', 'Restart the FastAPI server? The Docker container stays up; active generations stop.', 'Restart')) return;
      try { await api('/api/settings/restart', { method: 'POST' }); } catch { /* expected drop */ }
      toast('Restarting… reconnecting');
      const wait = async () => {
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 1500));
          try { await api('/api/settings/status'); location.reload(); return; } catch { }
        }
        toast('Backend did not come back — check the pod logs', 'error');
      };
      wait();
    },
  }, 'Restart backend');

  root.append(
    h('div', { class: 'view-head' }, h('h1', {}, 'Settings'),
      h('button', { class: 'btn ghost small', onclick: logoutAndReload }, 'Log out')),

    h('div', { class: 'card' },
      h('h3', {}, 'API credentials'),
      h('p', { class: 'muted' }, 'Stored encrypted with your browser-derived key. The server only holds ciphertext; keys are sent transiently when a download needs them.'),
      h('label', { class: 'field' }, h('span', {}, 'Hugging Face token'), hf),
      h('label', { class: 'field' }, h('span', {}, 'Civitai API key'), civ),
      saveKeys),

    h('div', { class: 'card section-gap' },
      h('h3', {}, 'Content moderation'),
      h('div', { class: 'row gap' }, modToggle, h('span', {}, 'Enable local image safety classifier'), installBtn),
      modDetail),

    h('div', { class: 'card section-gap' },
      h('h3', {}, 'Updates'),
      h('p', { class: 'muted' }, 'Pull the latest code from git and restart the backend — no container rebuild needed.'),
      h('div', { class: 'row gap' }, gitBtn, restartBtn),
      gitOut),

    h('div', { class: 'card section-gap' },
      h('h3', {}, 'Status'),
      h('div', { class: 'list' },
        statusRow('Version', status.version || 'no git info'),
        statusRow('Uptime', `${Math.floor(status.uptime_s / 60)} min`),
        statusRow('Mode', status.mock ? 'mock (no GPU)' : 'GPU'),
        statusRow('Data directory', status.data_dir),
        statusRow('Runner', status.runner.model_id ? `${status.runner.model_id} · ${status.runner.status}` : 'stopped'))));

  function statusRow(k, v) {
    return h('div', { class: 'list-row' }, h('span', { class: 'muted', style: 'width:140px' }, k), h('span', { class: 'mono' }, String(v)));
  }
}

function moderationDetail(s) {
  if (!s.enabled) return 'Off. When on, generated and reference images are checked by a local classifier before saving (fail-closed).';
  if (s.loaded) return 'On — classifier loaded.';
  if (!s.model_present) return 'On, but no classifier installed (data/moderation/model.onnx + labels.json). Saves will be BLOCKED until one is installed — fail closed.';
  return `On — classifier loads on first use.${s.load_error ? ` Last error: ${s.load_error}` : ''}`;
}
