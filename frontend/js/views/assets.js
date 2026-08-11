// Assets view: encrypted grid, on-the-fly decryption, metadata, delete,
// reference-image upload (encrypted client-side; optional moderation check first).
import { api, apiBlob } from '../api.js';
import { decryptBytes, decryptJSON, encryptBytes, encryptJSON } from '../crypto.js';
import { h, clear, toast, lightbox, confirmModal, spinner, fmtBytes } from '../ui.js';

const urlCache = new Map(); // asset id -> Promise<objectURL> (decrypted)

export function assetMime(asset) { return asset?.mime || 'image/png'; }

// Shared: decrypt an asset blob to an object URL (cached). Used here and by
// the Running queue to show completed generations.
export function decryptedAssetURL(assetId, mime = 'image/png') {
  if (urlCache.has(assetId)) return urlCache.get(assetId);
  const pending = (async () => {
    const resp = await apiBlob(`/api/assets/${assetId}/blob`);
    const plain = await decryptBytes(await resp.arrayBuffer());
    return URL.createObjectURL(new Blob([plain], { type: mime }));
  })();
  urlCache.set(assetId, pending);
  pending.catch(() => { if (urlCache.get(assetId) === pending) urlCache.delete(assetId); });
  return pending;
}

export function evictDecryptedAssetURL(assetId) {
  const pending = urlCache.get(assetId);
  urlCache.delete(assetId);
  if (pending) pending.then(url => URL.revokeObjectURL(url), () => {});
}

export async function saveReferenceAsset(bytes, name, mime) {
  const mod = await api('/api/moderate', { method: 'POST', body: { image_b64: bufToB64(bytes) } });
  if (mod.enabled && !mod.allowed) throw new Error('blocked by moderation');
  const encMeta = await encryptJSON({ name, type: mime, uploaded: Date.now() });
  const enc = await encryptBytes(bytes.slice(0));
  return api('/api/assets', { method: 'POST', body: enc, headers: {
    'X-Pleo-Kind': 'reference', 'X-Pleo-Meta': encMeta, 'X-Pleo-Mime': mime,
  } });
}

export async function render(root) {
  let filter = 'all';
  const uploadInput = h('input', { type: 'file', accept: '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp', multiple: true, style: 'display:none', onchange: () => uploadRefs(uploadInput.files) });

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

  async function deleteAsset(a) {
    if (!await confirmModal('Delete asset', 'Remove this asset from disk permanently?')) return false;
    try {
      await api(`/api/assets/${a.id}`, { method: 'DELETE' });
      evictDecryptedAssetURL(a.id);
      assets = assets.filter(x => x.id !== a.id);
      draw();
      toast('Asset deleted', 'success');
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
  }

  function tile(a) {
    const mime = assetMime(a);
    const isVideo = mime.startsWith('video/');
    const media = isVideo
      ? h('video', { muted: true, playsinline: true, preload: 'metadata', 'aria-label': `${a.kind} video` })
      : h('img', { alt: a.kind, loading: 'lazy' });
    const pop = h('div', { class: 'tile-pop', hidden: true },
      h('button', {
        class: 'tile-pop-item danger', onclick: (e) => { e.stopPropagation(); pop.hidden = true; deleteAsset(a); },
      }, 'Delete'));
    const menuBtn = h('button', {
      class: 'tile-menu', 'aria-label': 'Asset options', onclick: (e) => {
        e.stopPropagation();
        const wasHidden = pop.hidden;
        document.querySelectorAll('.tile-pop').forEach(p => { p.hidden = true; });
        pop.hidden = !wasHidden;
      },
    }, '⋮');
    const el = h('div', { class: 'asset-tile', onclick: async () => {
      pop.hidden = true;
      try { open(a, media.src || await decryptedAssetURL(a.id, mime)); }
      catch (e) { toast(e.message, 'error'); }
    } },
      media, h('span', { class: `badge tag ${a.kind === 'generated' ? 'ok' : ''}` }, `${a.kind}${isVideo ? ' · video' : ''}`),
      menuBtn, pop);
    decryptedAssetURL(a.id, mime).then(url => { media.src = url; }).catch(() => {
      el.classList.add('broken');
      el.append(h('span', { class: 'muted', style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center' }, 'decrypt failed'));
    });
    return el;
  }

  async function open(a, src) {
    const mime = assetMime(a);
    let metaText = `${a.kind} · ${fmtBytes(a.size)} · ${new Date(a.created * 1000).toLocaleString()}`;
    if (a.enc_meta) {
      try {
        const meta = await decryptJSON(a.enc_meta);
        const bits = [meta.prompt, meta.seed != null ? `seed ${meta.seed}` : null,
          meta.steps ? `${meta.steps} steps` : null, meta.cfg != null ? `cfg ${meta.cfg}` : null,
          meta.width ? `${meta.width}×${meta.height}` : null,
          meta.num_frames ? `${meta.num_frames} frames` : null,
          meta.fps ? `${meta.fps} fps` : null, meta.name].filter(Boolean);
        if (bits.length) metaText = `${bits.join(' · ')}\n${metaText}`;
      } catch { metaText += ' · (metadata unreadable)'; }
    }
    lightbox(src, {
      mime,
      metaEl: h('span', { style: 'white-space:pre-wrap' }, metaText),
      onDelete: () => deleteAsset(a),
    });
  }

  async function uploadRefs(files) {
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        await saveReferenceAsset(buf, f.name, f.type || 'image/png');
        toast(`${f.name} uploaded (encrypted)`, 'success');
      } catch (e) {
        toast(`${f.name}: ${e.message}`, 'error');
      }
    }
    load();
  }

  grid.append(spinner('Decrypting assets…'));
  await load();
  const onDocClick = () => document.querySelectorAll('.tile-pop').forEach(p => { p.hidden = true; });
  document.addEventListener('click', onDocClick);
  return () => document.removeEventListener('click', onDocClick);
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
