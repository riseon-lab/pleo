// LoRAs view: Hugging Face + Civitai download tabs, local list, progress.
import { api, apiBlob, onEvent } from '../api.js';
import { h, clear, toast, modal, confirmModal, fmtBytes } from '../ui.js';
import { getApiKeys } from './settings.js';

export async function render(root) {
  let tab = 'local';
  const tabsEl = h('div', { class: 'tabs' },
    [['local', 'Local'], ['hf', 'Hugging Face'], ['civitai', 'Civitai']].map(([t, label]) =>
      h('button', { class: `tab${t === tab ? ' active' : ''}`, dataset: { t }, onclick: (e) => { tab = t; sync(e.target); draw(); } }, label)));
  const body = h('div', {});
  const dlList = h('div', { class: 'list section-gap' });
  const dlCard = h('div', { class: 'card section-gap', hidden: true }, h('h3', {}, 'Downloads'), dlList);

  root.append(h('div', { class: 'view-head' }, h('h1', {}, 'LoRAs')), tabsEl, body, dlCard);

  function sync(active) { tabsEl.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el === active)); }

  async function draw() {
    clear(body);
    if (tab === 'local') return drawLocal();
    if (tab === 'hf') return drawHF();
    return drawCivitai();
  }

  // ---------- Local ----------
  async function drawLocal() {
    const { loras } = await api('/api/loras');
    const card = h('div', { class: 'card' });
    if (!loras.length) card.append(h('p', { class: 'muted' }, 'No LoRAs downloaded yet. Use the Hugging Face or Civitai tabs.'));
    const list = h('div', { class: 'list' });
    for (const l of loras) {
      list.append(h('div', { class: 'list-row' },
        h('div', { class: 'grow' },
          h('div', {}, l.label || l.file),
          h('div', { class: 'muted mono' }, `${l.file} · ${fmtBytes(l.size)}${l.source ? ` · ${l.source.kind}` : ''}`)),
        h('button', {
          class: 'btn small ghost', onclick: async (e) => {
            e.target.disabled = true;
            try {
              const resp = await apiBlob(`/api/loras/${encodeURIComponent(l.file)}/file`);
              const blob = await resp.blob();
              const a = h('a', { href: URL.createObjectURL(blob), download: l.file });
              document.body.append(a);
              a.click();
              setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
            } catch (err) { toast(err.message, 'error'); }
            e.target.disabled = false;
          },
        }, 'Download'),
        h('button', {
          class: 'btn small danger', onclick: async () => {
            if (!await confirmModal('Delete LoRA', `Remove ${l.file} from disk?`)) return;
            try { await api(`/api/loras/${encodeURIComponent(l.file)}`, { method: 'DELETE' }); toast('Deleted', 'success'); draw(); }
            catch (e) { toast(e.message, 'error'); }
          },
        }, 'Delete')));
    }
    card.append(list);
    body.append(card);
  }

  // ---------- Hugging Face ----------
  function drawHF() {
    const repo = h('input', { type: 'text', placeholder: 'org/repo — e.g. someuser/my-lora' });
    const file = h('input', { type: 'text', placeholder: 'filename — e.g. my-lora.safetensors' });
    const btn = h('button', {
      class: 'btn', onclick: async () => {
        if (!repo.value.trim() || !file.value.trim()) return toast('Repo and filename required', 'error');
        btn.disabled = true;
        try {
          const keys = await getApiKeys();
          await api('/api/loras/hf/download', {
            method: 'POST',
            body: { repo_id: repo.value.trim(), filename: file.value.trim(), api_key: keys.hf_key || null },
          });
          toast('Download started');
        } catch (e) { toast(e.message, 'error'); }
        btn.disabled = false;
      },
    }, 'Download');
    body.append(h('div', { class: 'card' },
      h('h3', {}, 'Download from Hugging Face'),
      h('label', { class: 'field' }, h('span', {}, 'Repo ID'), repo),
      h('label', { class: 'field' }, h('span', {}, 'Filename'), file),
      btn));
  }

  // ---------- Civitai ----------
  function drawCivitai() {
    const url = h('input', { type: 'url', placeholder: 'Civitai link — model page, version, or download URL' });
    const btn = h('button', {
      class: 'btn', onclick: async () => {
        if (!url.value.trim()) return;
        btn.disabled = true;
        btn.textContent = 'Resolving…';
        try {
          const keys = await getApiKeys();
          const { items } = await api('/api/loras/civitai/resolve', {
            method: 'POST', body: { url: url.value.trim(), api_key: keys.civitai_key || null },
          });
          pickerModal(items, keys.civitai_key || null);
        } catch (e) { toast(e.message, 'error'); }
        btn.disabled = false;
        btn.textContent = 'Fetch files';
      },
    }, 'Fetch files');
    body.append(h('div', { class: 'card' },
      h('h3', {}, 'Download from Civitai'),
      h('p', { class: 'muted' }, 'Paste any Civitai link — the available files show in a picker.'),
      h('label', { class: 'field' }, h('span', {}, 'URL'), url),
      btn));
  }

  function pickerModal(items, apiKey) {
    const list = h('div', { class: 'list' });
    for (const it of items) {
      list.append(h('div', { class: 'list-row' },
        it.preview ? h('img', { src: it.preview, style: 'width:52px;height:52px;object-fit:cover;border-radius:7px' }) : null,
        h('div', { class: 'grow' },
          h('div', {}, `${it.model_name ?? ''} — ${it.version_name ?? ''}`),
          h('div', { class: 'muted mono' }, `${it.file_name} · ${it.size_kb ? fmtBytes(it.size_kb * 1024) : '?'} · ${it.type ?? ''}`)),
        h('button', {
          class: 'btn small', onclick: async (e) => {
            e.target.disabled = true;
            try {
              await api('/api/loras/civitai/download', {
                method: 'POST',
                body: { download_url: it.download_url, file_name: it.file_name, api_key: apiKey, label: `${it.model_name} ${it.version_name}` },
              });
              toast('Download started');
              m.close();
            } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
          },
        }, 'Download')));
    }
    const m = modal('Choose files to download', list, { wide: true });
  }

  // ---------- Downloads progress ----------
  const active = new Map();
  function drawDownloads() {
    dlCard.hidden = active.size === 0;
    clear(dlList);
    for (const d of active.values()) {
      dlList.append(h('div', { class: 'list-row' },
        h('div', { class: 'grow' },
          h('div', { class: 'mono' }, d.file),
          h('div', { class: 'progress', style: 'margin-top:6px' },
            h('div', { style: `width:${d.progress ?? 5}%` }))),
        h('span', { class: `badge ${d.status === 'error' ? 'err' : d.status === 'done' ? 'ok' : 'busy'}` },
          d.status === 'downloading' ? `${d.progress ?? '…'}%` : d.status)));
    }
  }

  const off = onEvent((ev) => {
    if (ev.type !== 'lora_download') return;
    active.set(ev.id, ev);
    drawDownloads();
    if (ev.status === 'done') {
      toast(`${ev.file} downloaded`, 'success');
      setTimeout(() => { active.delete(ev.id); drawDownloads(); }, 4000);
      if (tab === 'local') draw();
    }
    if (ev.status === 'error') toast(`${ev.file}: ${ev.detail}`, 'error');
  });

  await draw();
  return off;
}
