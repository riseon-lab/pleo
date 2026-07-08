// Assets view: encrypted grid, on-the-fly decryption, metadata, delete,
// reference-image upload (encrypted client-side; optional moderation check first).
import { api, apiBlob } from '../api.js';
import { decryptBytes, decryptJSON, encryptBytes, encryptJSON } from '../crypto.js';
import { h, clear, toast, lightbox, confirmModal, spinner, fmtBytes } from '../ui.js';

const urlCache = new Map(); // asset id -> objectURL (decrypted)

export async function render(root) {
  let filter = 'all';
  const uploadInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none', onchange: () => uploadRefs(uploadInput.files) });

  const grid = h('div', { class: 'asset-grid' });
  const tabs = h('div', { class: 'tabs' },
    ['all', 'generated', 'reference'].map(t =>
      h('button', { class: `tab${t === filter ? ' active' : ''}`, dataset: { t }, onclick: (e) => { filter = t; syncTabs(e.target); draw(); } },
        t[0].toUpperCase() + t.slice(1))));

  root.append(
    h('div', { class: 'view-head' },
      h('h1', {}, 'Assets'),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn ghost small', onclick: () => uploadInput.click() }, 'Upload reference'),
        uploadInput)),
    tabs, grid);

  let assets = [];

  function syncTabs(active) {
    tabs.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el === active));
  }

  async function load() {
    assets = (await api('/api/assets')).assets;
    draw();
  }

  function draw() {
    clear(grid);
    const shown = assets.filter(a => filter === 'all' || a.kind === filter);
    if (!shown.length) {
      grid.append(h('p', { class: 'muted' }, 'No assets yet.'));
      return;
    }
    for (const a of shown) grid.append(tile(a));
  }

  function tile(a) {
    const img = h('img', { alt: a.kind, loading: 'lazy' });
    const el = h('div', { class: 'asset-tile', onclick: () => open(a, img.src) },
      img, h('span', { class: `badge tag ${a.kind === 'generated' ? 'ok' : ''}` }, a.kind));
    decryptToURL(a).then(url => { img.src = url; }).catch(() => {
      el.classList.add('broken');
      el.append(h('span', { class: 'muted', style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center' }, 'decrypt failed'));
    });
    return el;
  }

  async function decryptToURL(a) {
    if (urlCache.has(a.id)) return urlCache.get(a.id);
    const resp = await apiBlob(`/api/assets/${a.id}/blob`);
    const plain = await decryptBytes(await resp.arrayBuffer());
    const url = URL.createObjectURL(new Blob([plain], { type: 'image/png' }));
    urlCache.set(a.id, url);
    return url;
  }

  async function open(a, src) {
    let metaText = `${a.kind} · ${fmtBytes(a.size)} · ${new Date(a.created * 1000).toLocaleString()}`;
    if (a.enc_meta) {
      try {
        const meta = await decryptJSON(a.enc_meta);
        const bits = [meta.prompt, meta.seed != null ? `seed ${meta.seed}` : null,
          meta.steps ? `${meta.steps} steps` : null, meta.cfg != null ? `cfg ${meta.cfg}` : null,
          meta.width ? `${meta.width}×${meta.height}` : null, meta.name].filter(Boolean);
        if (bits.length) metaText = `${bits.join(' · ')}\n${metaText}`;
      } catch { metaText += ' · (metadata unreadable)'; }
    }
    lightbox(src, {
      metaEl: h('span', { style: 'white-space:pre-wrap' }, metaText),
      onDelete: async () => {
        if (!await confirmModal('Delete asset', 'Remove this asset from disk permanently?')) return false;
        try {
          await api(`/api/assets/${a.id}`, { method: 'DELETE' });
          urlCache.delete(a.id);
          assets = assets.filter(x => x.id !== a.id);
          draw();
          toast('Asset deleted', 'success');
          return true;
        } catch (e) { toast(e.message, 'error'); return false; }
      },
    });
  }

  async function uploadRefs(files) {
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        // Moderation pre-check happens before encryption (server can't see
        // the ciphertext later); only runs when the toggle is on.
        const mod = await api('/api/moderate', { method: 'POST', body: { image_b64: bufToB64(buf) } });
        if (mod.enabled && !mod.allowed) { toast(`${f.name}: blocked by moderation`, 'error'); continue; }
        const encMeta = await encryptJSON({ name: f.name, type: f.type, uploaded: Date.now() });
        const enc = await encryptBytes(buf);
        await api('/api/assets', { method: 'POST', body: enc, headers: { 'X-Pleo-Kind': 'reference', 'X-Pleo-Meta': encMeta } });
        toast(`${f.name} uploaded (encrypted)`, 'success');
      } catch (e) {
        toast(`${f.name}: ${e.message}`, 'error');
      }
    }
    load();
  }

  grid.append(spinner('Decrypting assets…'));
  await load();
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
