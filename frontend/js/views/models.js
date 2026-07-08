// Models view: weights download, env management, launch/stop, delete.
import { api, onEvent } from '../api.js';
import { h, clear, toast, confirmModal, fmtBytes } from '../ui.js';
import { getApiKeys } from './settings.js';

export async function render(root) {
  root.append(h('div', { class: 'view-head' }, h('h1', {}, 'Models'),
    h('button', { class: 'btn ghost small', onclick: () => refresh() }, 'Refresh')));
  const grid = h('div', { class: 'model-grid' });
  root.append(grid);

  let data = null;

  async function refresh() {
    data = await api('/api/models');
    draw();
  }

  function draw() {
    clear(grid);
    for (const m of data.models) grid.append(card(m));
  }

  function chip(text, cls = '') { return h('span', { class: `badge ${cls}` }, text); }

  function card(m) {
    const chips = [];
    chips.push(chip(m.kind === 'edit' ? 'image edit' : 'txt2img'));
    if (data.mock) chips.push(chip('mock mode', 'warn'));
    else chips.push(
      { none: chip('env: none'), creating: chip('env: creating…', 'busy'), installing: chip('env: installing…', 'busy'), ready: chip('env: ready', 'ok'), error: chip('env: error', 'err') }[m.env] || chip(`env: ${m.env}`));
    chips.push(
      { none: chip('weights: none'), downloading: chip(`weights: ${m.download?.progress ?? '…'}%`, 'busy'), downloaded: chip('weights: ready', 'ok') }[m.weights]);
    if (m.running) chips.push(chip(`running · ${m.runner_status}`, m.runner_status === 'busy' ? 'busy' : 'ok'));

    const actions = [];
    if (m.weights === 'none') {
      actions.push(h('button', { class: 'btn small', onclick: () => download(m) }, 'Download weights'));
    }
    if (!data.mock && m.env === 'none') {
      actions.push(h('button', { class: 'btn small ghost', onclick: () => act(`/api/envs/${m.id}/create`, 'Environment install started') }, 'Create env'));
    }
    if (!m.running) {
      actions.push(h('button', { class: 'btn small', onclick: () => launch(m) }, 'Launch'));
    } else {
      actions.push(h('button', { class: 'btn small ghost', onclick: () => act('/api/models/stop', 'Runner stopped') }, 'Stop'));
    }
    if (m.weights === 'downloaded') {
      actions.push(h('button', {
        class: 'btn small danger', onclick: async () => {
          if (await confirmModal('Delete weights', `Remove downloaded weights for ${m.name}? They can be re-downloaded.`))
            act(`/api/models/${m.id}/weights`, 'Weights deleted', 'DELETE');
        },
      }, 'Delete weights'));
    }
    if (!data.mock && ['ready', 'error'].includes(m.env)) {
      actions.push(h('button', {
        class: 'btn small ghost', onclick: async () => {
          if (await confirmModal('Delete environment', `Remove the virtual environment for ${m.name}?`))
            act(`/api/envs/${m.id}`, 'Environment deleted', 'DELETE');
        },
      }, 'Delete env'));
    }

    return h('div', { class: 'card model-card' },
      h('h3', {}, m.name),
      h('div', { class: 'repo mono' }, m.repo_id),
      h('div', { class: 'chips' }, chips),
      m.notes ? h('p', { class: 'muted' }, m.notes) : null,
      h('div', { class: 'model-actions' }, actions));
  }

  async function act(path, okMsg, method = 'POST') {
    try { await api(path, { method }); toast(okMsg, 'success'); refresh(); }
    catch (e) { toast(e.message, 'error'); refresh(); }
  }

  async function download(m) {
    try {
      const keys = await getApiKeys();
      await api(`/api/models/${m.id}/download`, { method: 'POST', body: { hf_key: keys.hf_key || null } });
      toast(`Downloading ${m.name} weights…`);
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function launch(m) {
    try {
      toast(`Launching ${m.name}… (first launch loads/downloads the model)`);
      await api(`/api/models/${m.id}/launch`, { method: 'POST' });
      toast(`${m.name} is ready`, 'success');
      refresh();
    } catch (e) { toast(e.message, 'error'); refresh(); }
  }

  const off = onEvent((ev) => {
    if (ev.type === 'env' || ev.type === 'runner') refresh();
    if (ev.type === 'model_download') {
      if (ev.status === 'done') { toast('Model download complete', 'success'); refresh(); }
      else if (ev.status === 'error') { toast(`Download failed: ${ev.detail}`, 'error'); refresh(); }
      else if (data) {
        const m = data.models.find(x => x.id === ev.model_id);
        if (m) {
          m.weights = 'downloading';
          m.download = { progress: ev.progress, detail: ev.total_bytes ? `${fmtBytes(ev.bytes)} / ${fmtBytes(ev.total_bytes)}` : '' };
          draw();
        }
      }
    }
  });

  await refresh();
  return off;
}
