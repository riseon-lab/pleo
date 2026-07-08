// Running view: generation controls, live step viewer, queue, lightbox.
import { api, apiBlob, onEvent } from '../api.js';
import { encryptBytes, encryptJSON } from '../crypto.js';
import { getParams, saveParams, getLoraStack, saveLoraStack, getUI, saveUI } from '../state.js';
import { h, clear, toast, modal, lightbox, fmtBytes } from '../ui.js';

const PRESETS = [
  { label: 'Square 512 × 512', w: 512, h: 512 },
  { label: 'Square 1024 × 1024', w: 1024, h: 1024 },
  { label: 'Portrait 832 × 1216', w: 832, h: 1216 },
  { label: 'Landscape 1216 × 832', w: 1216, h: 832 },
  { label: 'Portrait FHD 1080 × 1920', w: 1080, h: 1920 },
  { label: 'Landscape FHD 1920 × 1080', w: 1920, h: 1080 },
];

export async function render(root) {
  const [modelsRes, queueRes] = await Promise.all([api('/api/models'), api('/api/queue')]);
  const models = modelsRes.models;
  if (!models.length) {
    root.append(h('div', { class: 'card' }, h('h2', {}, 'No models configured'), h('p', { class: 'muted' }, 'Add entries to models.json.')));
    return;
  }
  let modelId = getUI().selectedModel;
  if (!models.some(m => m.id === modelId)) modelId = models[0].id;
  let model = models.find(m => m.id === modelId);
  let params = getParams(modelId, defaultsOf(model));
  let loraStack = getLoraStack(modelId);
  let refFile = null; // {b64, name} for edit models
  let liveJobId = null;

  // ---------- controls ----------
  const modelSel = h('select', {
    onchange: () => {
      persist();
      modelId = modelSel.value;
      model = models.find(m => m.id === modelId);
      params = getParams(modelId, defaultsOf(model));
      loraStack = getLoraStack(modelId);
      saveUI({ selectedModel: modelId });
      syncInputs();
    },
  }, models.map(m => h('option', { value: m.id, selected: m.id === modelId }, m.name)));

  const prompt = h('textarea', { placeholder: 'Prompt…', oninput: persist });
  const negative = h('textarea', { placeholder: 'Negative prompt (optional)', style: 'min-height:48px', oninput: persist });
  const steps = num({ min: 1, max: 200, step: 1 });
  const cfg = num({ min: 0, max: 30, step: 0.1 });
  const seed = num({ min: -1, max: 2147483647, step: 1 });
  const width = num({ min: 64, max: 2048, step: 8, oninput: () => { presetSel.value = 'custom'; persist(); syncAspect(); } });
  const height = num({ min: 64, max: 2048, step: 8, oninput: () => { presetSel.value = 'custom'; persist(); syncAspect(); } });
  const presetSel = h('select', {
    onchange: () => {
      const p = PRESETS.find(p => p.label === presetSel.value);
      if (p) { width.value = p.w; height.value = p.h; persist(); syncAspect(); }
    },
  },
    PRESETS.map(p => h('option', { value: p.label }, p.label)),
    h('option', { value: 'custom' }, 'Custom'));

  function num(attrs) { return h('input', { type: 'number', oninput: persist, ...attrs }); }

  const refInput = h('input', { type: 'file', accept: 'image/*', onchange: async () => {
    const f = refInput.files[0];
    if (!f) { refFile = null; return; }
    const buf = await f.arrayBuffer();
    refFile = { b64: bufToB64(buf), name: f.name };
  } });
  const refField = h('label', { class: 'field' }, h('span', {}, 'Reference image (required for edit models)'), refInput);

  const loraSummary = h('div', { class: 'lora-chiprow' });
  const loraBtn = h('button', { class: 'btn ghost small', onclick: openLoraModal }, 'Manage LoRAs');

  const genBtn = h('button', { class: 'btn', style: 'width:100%', onclick: submit }, 'Generate');

  const controls = h('div', { class: 'card' },
    h('label', { class: 'field' }, h('span', {}, 'Model'), modelSel),
    h('label', { class: 'field' }, h('span', {}, 'Prompt'), prompt),
    h('label', { class: 'field' }, h('span', {}, 'Negative prompt'), negative),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, 'Steps'), steps),
      h('label', { class: 'field' }, h('span', {}, 'CFG scale'), cfg)),
    h('label', { class: 'field' }, h('span', {}, 'Resolution'), presetSel),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, 'Width'), width),
      h('label', { class: 'field' }, h('span', {}, 'Height'), height)),
    h('label', { class: 'field' }, h('span', {}, 'Seed (−1 = random)'), seed),
    refField,
    h('div', { class: 'field' }, h('span', { style: 'display:block;font-size:12.5px;font-weight:600;color:var(--ink-soft);margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em' }, 'LoRA stack'), loraSummary, h('div', { style: 'margin-top:8px' }, loraBtn)),
    genBtn);

  // ---------- viewer ----------
  const previewImg = h('img', { alt: 'preview', hidden: true });
  const previewEmpty = h('div', { class: 'preview-empty' }, 'Generations appear here. Live noise previews stream in step by step.');
  const previewBox = h('div', { class: 'preview-box' }, previewImg, previewEmpty);
  const progressBar = h('div', {});
  const progressWrap = h('div', { class: 'progress', style: 'visibility:hidden' }, progressBar);
  const statusLine = h('div', { class: 'row between' },
    h('span', { class: 'muted', id: 'gen-status' }, 'Idle'),
    h('button', { class: 'btn ghost small', hidden: true, id: 'cancel-btn', onclick: cancelCurrent }, 'Cancel'));
  const viewer = h('div', { class: 'card viewer-card' },
    h('div', { class: 'preview-shell' }, previewBox),
    progressWrap, statusLine);

  const queueList = h('div', { class: 'queue-list' });
  const queueCard = h('div', { class: 'card section-gap' }, h('h3', {}, 'Queue'), queueList);

  const badgeHost = h('span', {}, runnerBadge(modelsRes.runner, models));
  root.append(h('div', { class: 'view-head' }, h('h1', {}, 'Running'), badgeHost),
    h('div', { class: 'run-layout' },
      controls,
      h('div', {}, viewer, queueCard)));

  syncInputs();
  renderQueue(queueRes);

  // ---------- behavior ----------
  function defaultsOf(m) {
    return { prompt: '', negative: '', ...m.defaults };
  }

  function persist() {
    saveParams(modelId, {
      prompt: prompt.value, negative: negative.value,
      steps: +steps.value, cfg: +cfg.value, seed: +seed.value,
      width: +width.value, height: +height.value,
    });
  }

  function syncInputs() {
    prompt.value = params.prompt ?? '';
    negative.value = params.negative ?? '';
    steps.value = params.steps;
    cfg.value = params.cfg;
    seed.value = params.seed;
    width.value = params.width;
    height.value = params.height;
    const p = PRESETS.find(p => p.w === +width.value && p.h === +height.value);
    presetSel.value = p ? p.label : 'custom';
    refField.style.display = model.kind === 'edit' ? '' : 'none';
    renderLoraSummary();
    syncAspect();
  }

  function syncAspect() {
    previewBox.style.aspectRatio = `${+width.value || 1} / ${+height.value || 1}`;
  }

  function renderLoraSummary() {
    clear(loraSummary);
    if (!loraStack.length) loraSummary.append(h('span', { class: 'muted' }, 'None active'));
    for (const l of loraStack) loraSummary.append(h('span', { class: 'lora-chip' }, `${l.file} · ${l.strength.toFixed(2)}`));
  }

  async function openLoraModal() {
    const { loras } = await api('/api/loras');
    const body = h('div', {});
    if (!loras.length) body.append(h('p', { class: 'muted' }, 'No local LoRAs yet — download some from the LoRAs page.'));
    for (const lora of loras) {
      const active = loraStack.find(l => l.file === lora.file);
      const check = h('input', { type: 'checkbox', checked: !!active });
      const slider = h('input', { type: 'range', min: -2, max: 2, step: 0.05, value: active ? active.strength : 1, disabled: !active });
      const valLabel = h('span', { class: 'mono', style: 'width:48px;text-align:right' }, (+slider.value).toFixed(2));
      slider.oninput = () => { valLabel.textContent = (+slider.value).toFixed(2); update(); };
      check.onchange = () => { slider.disabled = !check.checked; update(); };
      function update() {
        loraStack = loraStack.filter(l => l.file !== lora.file);
        if (check.checked) loraStack.push({ file: lora.file, strength: +slider.value });
        saveLoraStack(modelId, loraStack);
        renderLoraSummary();
      }
      body.append(h('div', { class: 'list-row' },
        check,
        h('div', { class: 'grow' },
          h('div', {}, lora.label || lora.file),
          h('div', { class: 'muted mono' }, `${lora.file} · ${fmtBytes(lora.size)}`)),
        h('div', { style: 'width:180px' }, slider), valLabel));
    }
    modal('LoRA stack', body, { wide: true });
  }

  async function submit() {
    persist();
    if (!prompt.value.trim()) { toast('Enter a prompt first', 'error'); return; }
    if (model.kind === 'edit' && !refFile) { toast('This model needs a reference image', 'error'); return; }
    genBtn.disabled = true;
    try {
      const body = {
        model_id: modelId,
        prompt: prompt.value,
        negative_prompt: negative.value,
        steps: +steps.value, cfg: +cfg.value,
        width: +width.value, height: +height.value,
        seed: +seed.value,
        loras: loraStack,
      };
      if (model.kind === 'edit' && refFile) body.ref_image_b64 = refFile.b64;
      const res = await api('/api/generate', { method: 'POST', body });
      toast(res.position > 1 ? `Queued (position ${res.position})` : 'Generation started');
      refreshQueue();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      genBtn.disabled = false;
    }
  }

  async function cancelCurrent() {
    if (liveJobId) {
      try { await api(`/api/jobs/${liveJobId}/cancel`, { method: 'POST' }); } catch (e) { toast(e.message, 'error'); }
    }
  }

  function setStatus(text, { cancellable = false, progress = null } = {}) {
    document.getElementById('gen-status').textContent = text;
    document.getElementById('cancel-btn').hidden = !cancellable;
    progressWrap.style.visibility = progress === null ? 'hidden' : 'visible';
    if (progress !== null) progressBar.style.width = `${progress}%`;
  }

  function showPreview(url) {
    previewImg.src = url;
    previewImg.hidden = false;
    previewEmpty.hidden = true;
  }

  async function refreshQueue() { renderQueue(await api('/api/queue')); }

  function renderQueue(q) {
    clear(queueList);
    const rows = [];
    if (q.current) rows.push([q.current, 'now']);
    for (const j of q.queued) rows.push([j, 'queued']);
    for (const j of q.history.slice(0, 8)) rows.push([j, 'past']);
    if (!rows.length) queueList.append(h('p', { class: 'muted' }, 'Nothing queued.'));
    for (const [j, kind] of rows) {
      const badgeClass = { done: 'ok', error: 'err', blocked: 'err', cancelled: 'warn', running: 'busy', starting: 'busy', queued: '' }[j.status] || '';
      queueList.append(h('div', { class: 'queue-item' },
        h('span', { class: `badge ${badgeClass}` }, j.status),
        h('span', { class: 'qprompt', title: j.prompt }, `${modelName(j.model_id)} — ${j.prompt}`),
        j.error ? h('span', { class: 'muted', title: j.error }, '⚠') : null,
        kind !== 'past' ? h('button', { class: 'icon-btn', 'aria-label': 'Cancel', onclick: () => api(`/api/jobs/${j.id}/cancel`, { method: 'POST' }).then(refreshQueue).catch(e => toast(e.message, 'error')) }, '✕') : null));
    }
  }

  function modelName(id) { return (models.find(m => m.id === id) || { name: id }).name; }

  async function collectResult(job) {
    try {
      const resp = await apiBlob(`/api/results/${job.result_id}`);
      const metaB64 = resp.headers.get('x-pleo-meta-plain');
      const meta = metaB64 ? JSON.parse(atob(metaB64)) : {};
      const bytes = await resp.arrayBuffer();
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      showPreview(url);
      previewImg.onclick = () => lightbox(url, { metaEl: h('span', {}, metaLine(meta)) });
      previewImg.style.cursor = 'zoom-in';
      // Encrypt in the browser, upload ciphertext, then discard the server copy.
      const encMeta = await encryptJSON({ ...meta, saved: Date.now() });
      const encBlob = await encryptBytes(bytes.slice(0));
      await api('/api/assets', { method: 'POST', body: encBlob, headers: { 'X-Pleo-Kind': 'generated', 'X-Pleo-Meta': encMeta } });
      await api(`/api/results/${job.result_id}`, { method: 'DELETE' });
      toast('Saved to assets (encrypted)', 'success');
    } catch (e) {
      toast(`Result save failed: ${e.message}`, 'error');
    }
  }

  function metaLine(meta) {
    return `${meta.prompt ?? ''} — seed ${meta.seed}, ${meta.steps} steps, cfg ${meta.cfg}, ${meta.width}×${meta.height}`;
  }

  // ---------- live events ----------
  const off = onEvent((ev) => {
    if (ev.type === 'runner') {
      clear(badgeHost).append(runnerBadge(ev, models));
      return;
    }
    if (ev.type === 'step' && ev.preview_b64) {
      liveJobId = ev.job_id;
      showPreview(`data:image/png;base64,${ev.preview_b64}`);
      const pct = ev.total ? Math.round(ev.step / ev.total * 100) : 0;
      setStatus(`Step ${ev.step} / ${ev.total}`, { cancellable: true, progress: pct });
    } else if (ev.type === 'job') {
      const j = ev.job;
      if (j.status === 'queued') refreshQueue();
      if (j.status === 'starting') { liveJobId = j.id; setStatus(`Starting ${modelName(j.model_id)}…`, { cancellable: true, progress: 0 }); refreshQueue(); }
      if (j.status === 'running') { liveJobId = j.id; setStatus('Generating…', { cancellable: true, progress: 0 }); refreshQueue(); }
      if (['done', 'error', 'cancelled', 'blocked'].includes(j.status)) {
        liveJobId = null;
        setStatus(j.status === 'done' ? 'Done' : `${j.status}${j.error ? `: ${j.error}` : ''}`);
        if (j.status === 'done' && j.result_id) collectResult(j);
        if (j.status === 'blocked') toast(j.error || 'Blocked by moderation', 'error');
        if (j.status === 'error') toast(j.error || 'Generation failed', 'error');
        refreshQueue();
      }
    }
  });
  return off;
}

function runnerBadge(runner, models) {
  if (!runner || runner.status === 'stopped') return h('span', { class: 'badge' }, 'runner stopped');
  const model = models.find(m => m.id === runner.model_id);
  const name = model ? model.name : (runner.model_id || 'runner');
  const cls = runner.status === 'busy' ? 'busy' : runner.status === 'ready' ? 'ok' : 'warn';
  return h('span', { class: `badge ${cls}` }, `${name} · ${runner.status}`);
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
