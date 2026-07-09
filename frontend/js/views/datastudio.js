// Data Studio: datasets, caption editing, auto-captioning, HF pull,
// import-from-assets. Dataset images are PLAINTEXT on the pod (training
// needs raw pixels) — the banner says so explicitly.
import { api, apiBlob, onEvent } from '../api.js';
import { decryptBytes } from '../crypto.js';
import { h, clear, toast, modal, confirmModal, fmtBytes, spinner, lightbox } from '../ui.js';
import { getApiKeys } from './settings.js';

let openDatasetId = null;

export async function render(root) {
  const body = h('div', {});
  root.append(
    h('div', { class: 'view-head' }, h('h1', {}, 'Data Studio')),
    h('div', { class: 'notice' },
      'Dataset images are stored unencrypted on the pod volume — the trainer needs raw pixels. Generated assets stay encrypted; only what you put here is plaintext.'),
    body);

  const offs = [];
  if (openDatasetId) await renderDetail(body, openDatasetId, offs);
  else await renderList(body, offs);
  return () => offs.forEach(f => f());
}

async function rerender(body, offs) {
  offs.splice(0).forEach(f => f());
  clear(body);
  if (openDatasetId) await renderDetail(body, openDatasetId, offs);
  else await renderList(body, offs);
}

// ---------------- list ----------------

async function renderList(body, offs) {
  const { datasets } = await api('/api/datasets');
  const name = h('input', { type: 'text', placeholder: 'New dataset name' });
  const createBtn = h('button', {
    class: 'btn', onclick: async () => {
      if (!name.value.trim()) return;
      try {
        const ds = await api('/api/datasets', { method: 'POST', body: { name: name.value } });
        openDatasetId = ds.id;
        rerender(body, offs);
      } catch (e) { toast(e.message, 'error'); }
    },
  }, 'Create');

  const grid = h('div', { class: 'model-grid' });
  for (const ds of datasets) {
    grid.append(h('div', { class: 'card model-card' },
      h('h3', {}, ds.name),
      h('p', { class: 'muted' }, `${ds.count} images · ${ds.captioned} captioned` +
        (ds.trigger_word ? ` · trigger “${ds.trigger_word}”` : '')),
      h('div', { class: 'model-actions' },
        h('button', { class: 'btn small', onclick: () => { openDatasetId = ds.id; rerender(body, offs); } }, 'Open'),
        h('button', {
          class: 'btn small danger', onclick: async () => {
            if (!await confirmModal('Delete dataset', `Delete “${ds.name}” and all its images/captions?`)) return;
            try { await api(`/api/datasets/${ds.id}`, { method: 'DELETE' }); rerender(body, offs); }
            catch (e) { toast(e.message, 'error'); }
          },
        }, 'Delete'))));
  }
  body.append(
    h('div', { class: 'card', style: 'margin-bottom:18px' },
      h('div', { class: 'row gap' }, name, createBtn)),
    datasets.length ? grid : h('p', { class: 'muted' }, 'No datasets yet — create one to start.'));
}

// ---------------- detail ----------------

async function renderDetail(body, dsId, offs) {
  let ds;
  try { ds = await api(`/api/datasets/${dsId}`); }
  catch (e) { openDatasetId = null; toast(e.message, 'error'); return renderList(body, offs); }

  const back = h('button', { class: 'btn ghost small', onclick: () => { openDatasetId = null; rerender(body, offs); } }, '← Datasets');

  // --- captioner panel (full lifecycle: env → weights → start/stop) ---
  const capStatus = h('span', { class: 'badge' }, '…');
  const envBtn = h('button', { class: 'btn small ghost', hidden: true }, 'Create env');
  const capBtn = h('button', { class: 'btn small ghost' }, '…');
  const weightsBtn = h('button', { class: 'btn small danger', hidden: true }, 'Delete weights');
  const autoBtn = h('button', { class: 'btn small' }, 'Auto-caption');
  const overwrite = h('input', { type: 'checkbox' });
  const capProgress = h('span', { class: 'muted' }, '');
  const capDetail = h('p', { class: 'muted', style: 'margin:8px 0 0' }, '');

  async function refreshCaptioner() {
    const s = await api('/api/captioner');
    const mockEnv = s.env === 'mock';
    const envReady = mockEnv || s.env === 'ready';
    const settled = s.status === 'stopped' || s.status === 'ready' || s.status === 'busy';
    capStatus.textContent = `${s.status}${mockEnv ? '' : ` · env ${s.env}`}`;
    capStatus.className = `badge ${s.status === 'ready' ? 'ok' : s.status === 'stopped' ? '' : 'busy'}`;
    capDetail.textContent = s.env === 'installing' || s.env === 'creating'
      ? (s.env_detail || 'Installing environment…')
      : `${s.model}${s.weights === 'downloaded' ? ` · weights ${fmtBytes(s.weights_bytes)} on disk` : mockEnv ? '' : ' · weights download on first start'}`;

    // Env creation (real mode only)
    envBtn.hidden = mockEnv || envReady;
    envBtn.disabled = s.env === 'creating' || s.env === 'installing';
    envBtn.textContent = envBtn.disabled ? 'Installing env…'
      : s.env === 'error' ? 'Retry env install' : 'Create env';
    envBtn.onclick = async () => {
      envBtn.disabled = true;
      try {
        if (s.env === 'error') await api('/api/envs/captioner', { method: 'DELETE' });
        await api('/api/envs/captioner/create', { method: 'POST' });
        toast('Captioner environment install started');
      } catch (e) { toast(e.message, 'error'); }
      refreshCaptioner();
    };

    // Start / stop
    capBtn.textContent = s.status === 'stopped' ? 'Start captioner'
      : settled ? 'Stop captioner' : 'Starting…';
    capBtn.disabled = !settled || (s.status === 'stopped' && !envReady);
    autoBtn.disabled = !(s.status === 'ready' || s.status === 'busy');
    capBtn.onclick = async () => {
      capBtn.disabled = true;
      capBtn.textContent = s.status === 'stopped' ? 'Starting…' : 'Stopping…';
      try { await api(`/api/captioner/${s.status === 'stopped' ? 'start' : 'stop'}`, { method: 'POST' }); }
      catch (e) { toast(e.message, 'error'); }
      refreshCaptioner();
    };

    // Delete weights (free disk space; only when stopped)
    weightsBtn.hidden = !(s.weights === 'downloaded' && s.status === 'stopped');
    weightsBtn.onclick = async () => {
      if (!await confirmModal('Delete captioner weights',
        `Remove ${s.model} weights (${fmtBytes(s.weights_bytes)}) from disk? They re-download on next start.`)) return;
      try { await api('/api/captioner/weights', { method: 'DELETE' }); toast('Captioner weights deleted', 'success'); }
      catch (e) { toast(e.message, 'error'); }
      refreshCaptioner();
    };
  }
  autoBtn.onclick = async () => {
    try {
      const r = await api(`/api/datasets/${dsId}/autocaption`, { method: 'POST', body: { overwrite: overwrite.checked } });
      toast(r.queued ? `Captioning ${r.queued} images…` : 'Nothing to caption');
    } catch (e) { toast(e.message, 'error'); }
  };

  // --- trigger word ---
  const trigger = h('input', { type: 'text', value: ds.trigger_word || '', placeholder: 'e.g. xk3mple' });
  const saveTrigger = h('button', {
    class: 'btn small ghost', onclick: async () => {
      try { await api(`/api/datasets/${dsId}/trigger`, { method: 'PUT', body: { trigger_word: trigger.value } }); toast('Trigger saved', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    },
  }, 'Save');
  const applyTrigger = h('button', {
    class: 'btn small ghost', onclick: async () => {
      try {
        const r = await api(`/api/datasets/${dsId}/trigger/apply`, { method: 'POST' });
        toast(`Trigger added to ${r.changed} captions`, 'success');
        rerender(body, offs);
      } catch (e) { toast(e.message, 'error'); }
    },
  }, 'Apply to captions');

  // --- add images ---
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none', onchange: () => uploadFiles(fileInput.files) });
  const hfRepo = h('input', { type: 'text', placeholder: 'org/dataset-repo' });

  async function uploadFiles(files) {
    for (const f of files) {
      try {
        await api(`/api/datasets/${dsId}/images`, { method: 'POST', body: await f.arrayBuffer(), headers: { 'X-Pleo-Filename': f.name } });
      } catch (e) { toast(`${f.name}: ${e.message}`, 'error'); }
    }
    toast('Upload complete', 'success');
    rerender(body, offs);
  }

  async function importFromAssets() {
    const { assets } = await api('/api/assets');
    if (!assets.length) return toast('No assets to import', 'error');
    const list = h('div', { class: 'asset-grid' });
    const m = modal('Import from assets (decrypts into the dataset)', list, { wide: true });
    for (const a of assets.slice(0, 60)) {
      const img = h('img', { alt: a.kind });
      const tile = h('div', {
        class: 'asset-tile', onclick: async () => {
          try {
            const resp = await apiBlob(`/api/assets/${a.id}/blob`);
            const plain = await decryptBytes(await resp.arrayBuffer());
            await api(`/api/datasets/${dsId}/images`, { method: 'POST', body: plain, headers: { 'X-Pleo-Filename': `asset-${a.id}.png` } });
            toast('Imported', 'success');
            tile.style.opacity = 0.35;
          } catch (e) { toast(e.message, 'error'); }
        },
      }, img);
      list.append(tile);
      apiBlob(`/api/assets/${a.id}/blob`).then(r => r.arrayBuffer()).then(decryptBytes)
        .then(p => { img.src = URL.createObjectURL(new Blob([p])); }).catch(() => tile.remove());
    }
  }

  async function pullHF() {
    if (!hfRepo.value.trim()) return;
    try {
      const keys = await getApiKeys();
      await api(`/api/datasets/${dsId}/pull-hf`, { method: 'POST', body: { repo_id: hfRepo.value.trim(), api_key: keys.hf_key || null } });
      toast('Pulling dataset from Hugging Face…');
    } catch (e) { toast(e.message, 'error'); }
  }

  // --- image grid with caption editors ---
  const grid = h('div', { class: 'ds-grid' });
  for (const item of ds.items) {
    grid.append(dsTile(dsId, item, () => rerender(body, offs)));
  }

  body.append(
    h('div', { class: 'row gap', style: 'margin-bottom:14px; flex-wrap:wrap' }, back,
      h('h2', { style: 'margin:0' }, ds.name),
      h('span', { class: 'muted' }, `${ds.count} images · ${ds.captioned} captioned`)),
    h('div', { class: 'card', style: 'margin-bottom:16px' },
      h('div', { class: 'row gap', style: 'flex-wrap:wrap' },
        h('button', { class: 'btn small', onclick: () => fileInput.click() }, 'Upload images'), fileInput,
        h('button', { class: 'btn small ghost', onclick: importFromAssets }, 'Import from assets'),
        h('div', { class: 'row gap', style: 'flex:1;min-width:260px' }, hfRepo,
          h('button', { class: 'btn small ghost', onclick: pullHF }, 'Pull from HF')))),
    h('div', { class: 'card', style: 'margin-bottom:16px' },
      h('h3', {}, 'Captions'),
      h('div', { class: 'row gap', style: 'flex-wrap:wrap' },
        capStatus, envBtn, capBtn, weightsBtn, autoBtn,
        h('label', { class: 'row gap', style: 'gap:6px' }, overwrite, h('span', { class: 'muted' }, 'overwrite existing')),
        capProgress),
      capDetail,
      h('div', { class: 'row gap', style: 'margin-top:12px; flex-wrap:wrap' },
        h('span', { class: 'muted', style: 'min-width:90px' }, 'Trigger word'),
        h('div', { style: 'width:200px' }, trigger), saveTrigger, applyTrigger)),
    ds.items.length ? grid : h('p', { class: 'muted' }, 'No images yet — upload, import, or pull from Hugging Face.'));

  refreshCaptioner();

  offs.push(onEvent((ev) => {
    if (ev.type === 'captioner') refreshCaptioner();
    if (ev.type === 'env' && ev.model_id === 'captioner') {
      if (ev.status === 'ready') toast('Captioner environment ready', 'success');
      if (ev.status === 'error') toast(`Captioner env failed: ${ev.detail}`, 'error');
      refreshCaptioner();
    }
    if (ev.type === 'autocaption' && ev.dataset_id === dsId) {
      if (ev.status === 'running') capProgress.textContent = `${ev.done}/${ev.total}`;
      if (ev.status === 'done') { capProgress.textContent = ''; toast('Auto-captioning finished', 'success'); rerender(body, offs); }
      if (ev.status === 'error') toast(`Captioning failed: ${ev.detail}`, 'error');
    }
    if (ev.type === 'dataset_pull' && ev.dataset_id === dsId) {
      if (ev.status === 'done') { toast(`Pulled ${ev.copied} images`, 'success'); rerender(body, offs); }
      if (ev.status === 'error') toast(`HF pull failed: ${ev.detail}`, 'error');
    }
  }));
}

function dsTile(dsId, item, refresh) {
  const url = `/api/datasets/${dsId}/images/${encodeURIComponent(item.file)}`;
  const img = h('img', { alt: item.file, loading: 'lazy' });
  // dataset images need the auth header — fetch to blob
  apiBlob(url).then(r => r.blob()).then(b => { img.src = URL.createObjectURL(b); }).catch(() => {});
  const caption = h('textarea', { placeholder: 'caption…' }, item.caption);
  let saved = item.caption;
  caption.onblur = async () => {
    if (caption.value === saved) return;
    try {
      await api(`/api/datasets/${dsId}/caption`, { method: 'PUT', body: { file: item.file, caption: caption.value } });
      saved = caption.value;
      toast('Caption saved', 'success', 1200);
    } catch (e) { toast(e.message, 'error'); }
  };
  return h('div', { class: 'card ds-item' },
    h('div', { class: 'ds-thumb', onclick: () => img.src && lightbox(img.src, { metaEl: h('span', {}, item.file) }) }, img),
    caption,
    h('div', { class: 'row between', style: 'margin-top:6px' },
      h('span', { class: 'muted mono', style: 'font-size:11px' }, `${item.file} · ${fmtBytes(item.size)}`),
      h('button', {
        class: 'icon-btn', 'aria-label': 'Delete image', onclick: async () => {
          try { await api(`/api/datasets/${dsId}/images/${encodeURIComponent(item.file)}`, { method: 'DELETE' }); refresh(); }
          catch (e) { toast(e.message, 'error'); }
        },
      }, '✕')));
}
