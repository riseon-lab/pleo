// Training: LoRA jobs — config, live progress, checkpoints with samples,
// ETA + cost from your RunPod hourly rate, push to HF, promote to LoRAs.
import { api, apiBlob, onEvent } from '../api.js';
import { h, clear, toast, confirmModal, fmtBytes, lightbox, modal } from '../ui.js';
import { getApiKeys } from './settings.js';

const RATE_KEY = 'pleo-runpod-rate';
const liveTails = new Map();   // job id -> latest log_tail from SSE
const sampleURLs = new Map();  // "jobId/file" -> objectURL (decode once)
const VRAM_KEY = 'pleo-vram-profile';

const VRAM_LABELS = {
  low: '24 GB — safe (fully quantized)',
  balanced: '48 GB — balanced',
  high: '80 GB+ — fast (no quantization)',
};

export async function render(root) {
  const [meta, { models }, { datasets }] = await Promise.all([
    api('/api/training/jobs'), api('/api/models'), api('/api/datasets')]);
  const { jobs, mock } = meta;
  const trainable = models.filter(m => m.trainable);

  const jobsHost = h('div', {});
  const envCard = mock ? null : trainerEnvCard();
  root.append(...[
    h('div', { class: 'view-head' }, h('h1', {}, 'Training'),
      mock ? h('span', { class: 'badge warn' }, 'mock mode') : null),
    envCard,
    newJobCard(trainable, datasets, meta),
    h('h2', { class: 'section-gap' }, 'Jobs'),
    jobsHost].filter(Boolean));

  let jobList = jobs;
  drawJobs();

  function drawJobs() {
    clear(jobsHost);
    if (!jobList.length) jobsHost.append(h('p', { class: 'muted' }, 'No training jobs yet.'));
    for (const job of jobList) jobsHost.append(jobCard(job, refresh));
  }

  async function refresh() {
    jobList = (await api('/api/training/jobs')).jobs;
    drawJobs();
  }

  const off = onEvent((ev) => {
    if (ev.type === 'env' && ev.model_id === 'trainer' && envCard) {
      if (ev.status === 'ready') toast('Trainer environment ready', 'success');
      if (ev.status === 'error') toast(`Trainer env failed: ${ev.detail}`, 'error');
      envCard.refresh();
    }
    if (ev.type === 'toolkit' && envCard) {
      envCard.applyToolkit(ev);
      if (ev.status === 'ready') toast('ai-toolkit ready — you can start training', 'success');
      if (ev.status === 'error') toast(`ai-toolkit install failed: ${ev.detail}`, 'error');
    }
    if (ev.type === 'training') {
      if (ev.log_tail) liveTails.set(ev.job.id, ev.log_tail);
      const i = jobList.findIndex(j => j.id === ev.job.id);
      if (i >= 0) jobList[i] = ev.job; else jobList.unshift(ev.job);
      drawJobs();
    }
    if (ev.type === 'training_push') {
      if (ev.status === 'uploading') toast(`Uploading to HF: ${ev.detail}`, 'info', 2000);
      if (ev.status === 'done') toast(`Pushed to HF: ${ev.repo}`, 'success', 6000);
      if (ev.status === 'error') toast(`HF push failed: ${ev.detail}`, 'error', 6000);
      if (ev.status === 'skipped') toast(ev.detail || 'HF push skipped (mock mode)');
    }
  });
  return off;
}

// ---------------- trainer environment (real mode) ----------------

function trainerEnvCard() {
  const status = h('span', { class: 'badge' }, '…');
  const detail = h('span', { class: 'muted' }, '');
  const createBtn = h('button', { class: 'btn small ghost' }, 'Create env');
  const deleteBtn = h('button', { class: 'btn small danger', hidden: true }, 'Delete env');
  const tkStatus = h('span', { class: 'badge' }, '…');
  const tkBtn = h('button', { class: 'btn small ghost' }, 'Install ai-toolkit');
  const tkDetail = h('div', { class: 'muted', style: 'margin-top:6px;font-size:12.5px;word-break:break-word' }, '');
  const card = h('div', { class: 'card', style: 'margin-bottom:16px' },
    h('h3', {}, 'Trainer setup'),
    h('p', { class: 'muted' },
      '1. Create the isolated venv. 2. Install ai-toolkit (clones the repo and installs its requirements — a few minutes). Then start training.'),
    h('div', { class: 'row gap', style: 'flex-wrap:wrap' }, status, createBtn, deleteBtn, detail),
    h('div', { class: 'row gap', style: 'flex-wrap:wrap;margin-top:10px' }, tkStatus, tkBtn),
    tkDetail);

  let envReady = false;

  card.applyToolkit = (t) => {
    const busy = t.status === 'cloning' || t.status === 'installing';
    tkStatus.textContent = t.present || t.status === 'ready' ? 'ai-toolkit ready'
      : busy ? `ai-toolkit ${t.status}…` : t.status === 'error' ? 'ai-toolkit error' : 'ai-toolkit missing';
    tkStatus.className = `badge ${t.status === 'ready' || t.present ? 'ok' : busy ? 'busy' : t.status === 'error' ? 'err' : 'warn'}`;
    tkBtn.textContent = busy ? 'Installing…'
      : t.status === 'error' ? 'Retry install'
      : t.present ? 'Update ai-toolkit' : 'Install ai-toolkit';
    tkBtn.disabled = busy || (!envReady && !t.present);
    tkDetail.textContent = t.detail || (!envReady && !t.present ? 'Create the trainer env first.' : '');
  };
  tkBtn.onclick = async () => {
    tkBtn.disabled = true;
    try { await api('/api/training/toolkit/install', { method: 'POST' }); toast('ai-toolkit install started'); }
    catch (e) { toast(e.message, 'error'); tkBtn.disabled = false; }
  };

  card.refresh = async () => {
    const [envs, toolkit] = await Promise.all([api('/api/envs'), api('/api/training/toolkit')]);
    const s = envs.trainer || { status: 'none', detail: '' };
    envReady = s.status === 'ready';
    card.applyToolkit(toolkit);
    status.textContent = `env ${s.status}`;
    status.className = `badge ${s.status === 'ready' ? 'ok' : s.status === 'none' ? '' : s.status === 'error' ? 'err' : 'busy'}`;
    detail.textContent = ['creating', 'installing'].includes(s.status) ? (s.detail || '') : (s.status === 'error' ? s.detail : '');
    createBtn.hidden = s.status === 'ready';
    createBtn.disabled = ['creating', 'installing'].includes(s.status);
    createBtn.textContent = createBtn.disabled ? 'Installing…' : s.status === 'error' ? 'Retry env install' : 'Create env';
    deleteBtn.hidden = !['ready', 'error'].includes(s.status);
    createBtn.onclick = async () => {
      createBtn.disabled = true;
      try {
        if (s.status === 'error') await api('/api/envs/trainer', { method: 'DELETE' });
        await api('/api/envs/trainer/create', { method: 'POST' });
        toast('Trainer environment install started');
      } catch (e) { toast(e.message, 'error'); }
      card.refresh();
    };
    deleteBtn.onclick = async () => {
      if (!await confirmModal('Delete trainer env', 'Remove the trainer virtual environment from disk?')) return;
      try { await api('/api/envs/trainer', { method: 'DELETE' }); toast('Trainer env deleted', 'success'); }
      catch (e) { toast(e.message, 'error'); }
      card.refresh();
    };
  };
  card.refresh();
  return card;
}

// ---------------- new job form ----------------

function newJobCard(trainable, datasets, meta) {
  const defaultCheckpoints = meta.default_checkpoints;
  const OPTIMIZERS = meta.optimizers || ['adamw8bit'];
  const SCHEDULERS = meta.lr_schedulers || ['constant'];
  const name = h('input', { type: 'text', placeholder: 'e.g. my-character-v1' });
  const dsSel = h('select', {}, datasets.map(d =>
    h('option', { value: d.id }, `${d.name} (${d.count} imgs, ${d.captioned} captioned)`)));
  const modelSel = h('select', {}, trainable.map(m => h('option', { value: m.id }, m.name)));
  const trigger = h('input', { type: 'text', placeholder: 'auto-added to captions' });
  const genTrigger = h('button', {
    class: 'btn small ghost', onclick: () => {
      const chars = 'bcdfghjklmnpqrstvwxz';
      trigger.value = Array.from({ length: 3 }, () =>
        chars[Math.floor(Math.random() * chars.length)] +
        'aeiou'[Math.floor(Math.random() * 5)]).join('') + Math.floor(Math.random() * 90 + 10);
    },
  }, 'Generate');
  const steps = h('input', { type: 'number', min: 50, max: 20000, step: 250, value: 2000 });
  const stepsHint = h('span', { class: 'muted' }, '250 → 20,000 in steps of 250 — or type any count (e.g. 300)');
  const suggestText = h('span', { class: 'muted' }, '');
  const suggestBtn = h('button', { class: 'btn small ghost', hidden: true }, 'Use');
  const suggestRow = h('div', { class: 'row gap', style: 'margin-top:4px' }, suggestText, suggestBtn);

  function updateSuggestion() {
    const ds = datasets.find(d => d.id === dsSel.value);
    if (!ds || !ds.count) { suggestText.textContent = ''; suggestBtn.hidden = true; return; }
    // Character-LoRA rule of thumb: ~100 steps/image for Qwen (20B learns
    // faster per step), ~150 for Z-Image; snapped to 250, clamped 500-6000.
    const isQwen = (modelSel.value || '').startsWith('qwen');
    const per = isQwen ? 100 : 150;
    const suggested = Math.max(500, Math.min(6000, Math.round(ds.count * per / 250) * 250));
    suggestText.textContent = `Suggested for ${ds.count} images on ${isQwen ? 'Qwen' : 'Z-Image'}: ~${suggested} steps`;
    suggestBtn.hidden = false;
    suggestBtn.onclick = () => { steps.value = suggested; };
  }
  dsSel.addEventListener('change', updateSuggestion);
  modelSel.addEventListener('change', updateSuggestion);
  updateSuggestion();
  const checkpoints = h('input', { type: 'text', value: defaultCheckpoints.join(', ') });
  const samples = h('textarea', { placeholder: 'One sample prompt per line — rendered at every checkpoint', style: 'min-height:60px' });
  const rank = h('input', { type: 'number', min: 1, max: 128, value: 16 });
  const alpha = h('input', { type: 'number', min: 1, max: 256, placeholder: '= rank' });
  const lr = h('input', { type: 'text', value: '1e-4' });
  const scheduler = h('select', {}, SCHEDULERS.map(s =>
    h('option', { value: s, selected: s === 'constant' }, s.replaceAll('_', ' '))));
  const optimizer = h('select', {}, OPTIMIZERS.map(o =>
    h('option', { value: o, selected: o === 'adamw8bit' }, o)));
  const resolution = h('input', { type: 'number', min: 256, max: 2048, step: 64, value: 1024 });
  const batch = h('input', { type: 'number', min: 1, max: 8, value: 1 });
  const savedProfile = localStorage.getItem(VRAM_KEY) || 'low';
  const vram = h('select', {}, (meta.vram_profiles || ['low']).map(p =>
    h('option', { value: p, selected: p === savedProfile }, VRAM_LABELS[p] || p)));
  vram.onchange = () => localStorage.setItem(VRAM_KEY, vram.value);
  const gradCkpt = h('input', { type: 'checkbox', checked: true });
  const rate = h('input', { type: 'number', min: 0, step: 0.01, value: localStorage.getItem(RATE_KEY) || '', placeholder: 'e.g. 0.69' });
  rate.oninput = () => localStorage.setItem(RATE_KEY, rate.value);
  const pushToggle = h('input', { type: 'checkbox' });
  const pushRepo = h('input', { type: 'text', placeholder: 'org/my-lora', disabled: true });
  pushToggle.onchange = () => { pushRepo.disabled = !pushToggle.checked; };

  const submit = h('button', {
    class: 'btn', onclick: async () => {
      if (!datasets.length) return toast('Create a dataset in Data Studio first', 'error');
      if (!name.value.trim()) return toast('Name the job', 'error');
      submit.disabled = true;
      try {
        const keys = await getApiKeys();
        const body = {
          name: name.value, dataset_id: dsSel.value, base_model: modelSel.value,
          trigger_word: trigger.value,
          steps: +steps.value,
          checkpoint_steps: checkpoints.value.split(',').map(s => +s.trim()).filter(n => n > 0),
          sample_prompts: samples.value.split('\n').map(s => s.trim()).filter(Boolean),
          rank: +rank.value, alpha: alpha.value ? +alpha.value : null,
          lr: +lr.value, lr_scheduler: scheduler.value, optimizer: optimizer.value,
          resolution: +resolution.value, batch_size: +batch.value,
          vram_profile: vram.value, gradient_checkpointing: gradCkpt.checked,
        };
        if (pushToggle.checked && pushRepo.value.trim()) {
          body.hf_push = { repo_id: pushRepo.value.trim(), private: true };
          body.hf_key = keys.hf_key || null;
        }
        await api('/api/training/jobs', { method: 'POST', body });
        toast('Training started', 'success');
      } catch (e) { toast(e.message, 'error'); }
      submit.disabled = false;
    },
  }, 'Start training');

  return h('div', { class: 'card' },
    h('h3', {}, 'New LoRA training job'),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, 'Job name'), name),
      h('label', { class: 'field' }, h('span', {}, 'Dataset'), dsSel),
      h('label', { class: 'field' }, h('span', {}, 'Base model'), modelSel),
      h('label', { class: 'field' }, h('span', {}, 'Trigger word'),
        h('div', { class: 'row gap' }, trigger, genTrigger))),
    h('label', { class: 'field' }, h('span', {}, 'Total steps'), steps, stepsHint, suggestRow),
    h('label', { class: 'field' }, h('span', {}, 'Checkpoint saves (steps, comma-separated — manual saves any time)'), checkpoints),
    h('label', { class: 'field' }, h('span', {}, 'Checkpoint sample prompts'), samples),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, 'LoRA rank'), rank),
      h('label', { class: 'field' }, h('span', {}, 'LoRA alpha'), alpha),
      h('label', { class: 'field' }, h('span', {}, 'Learning rate'), lr),
      h('label', { class: 'field' }, h('span', {}, 'LR scheduler'), scheduler),
      h('label', { class: 'field' }, h('span', {}, 'Optimizer'), optimizer),
      h('label', { class: 'field' }, h('span', {}, 'Resolution'), resolution),
      h('label', { class: 'field' }, h('span', {}, 'Batch size'), batch),
      h('label', { class: 'field' }, h('span', {}, 'GPU VRAM profile'), vram,
        h('span', { class: 'muted', style: 'font-size:12px' }, 'Higher = faster (less/no quantization); pick what fits the card')),
      h('label', { class: 'field' }, h('span', {}, 'Gradient checkpointing'),
        h('div', { class: 'row gap', style: 'padding:9px 0' }, gradCkpt,
          h('span', { class: 'muted', style: 'font-size:12px' }, 'Uncheck only with big VRAM headroom — faster steps, much more memory')))),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, 'RunPod $/hr (for ETA cost)'), rate),
      h('label', { class: 'field' }, h('span', {}, 'Push to Hugging Face on completion'),
        h('div', { class: 'row gap' }, pushToggle, pushRepo))),
    submit);
}

// ---------------- job cards ----------------

function jobCard(job, refresh) {
  const pct = job.steps ? Math.round((job.step || 0) / job.steps * 100) : 0;
  const rate = parseFloat(localStorage.getItem(RATE_KEY) || '0');
  let etaText = '—';
  if (job.status === 'running' && job.sec_per_step) {
    const remaining = (job.steps - job.step) * job.sec_per_step;
    etaText = fmtDuration(remaining);
    if (rate > 0) etaText += ` · ~$${(remaining / 3600 * rate).toFixed(2)} left`;
    if (rate > 0) etaText += ` (total ~$${(job.steps * job.sec_per_step / 3600 * rate).toFixed(2)})`;
  } else if (job.status === 'done' && job.started && job.finished) {
    const took = job.finished - job.started;
    etaText = `took ${fmtDuration(took)}` + (rate > 0 ? ` · ~$${(took / 3600 * rate).toFixed(2)}` : '');
  }
  const badgeCls = { running: 'busy', done: 'ok', error: 'err', cancelled: 'warn' }[job.status] || '';

  const actions = [];
  if (job.status === 'running') {
    actions.push(
      h('button', {
        class: 'btn small ghost', onclick: async () => {
          try { await api(`/api/training/jobs/${job.id}/checkpoint`, { method: 'POST' }); toast('Manual checkpoint queued', 'success'); }
          catch (e) { toast(e.message, 'error'); }
        },
      }, 'Save checkpoint now'),
      h('button', {
        class: 'btn small danger', onclick: async () => {
          try { await api(`/api/training/jobs/${job.id}/cancel`, { method: 'POST' }); } catch (e) { toast(e.message, 'error'); }
        },
      }, 'Cancel'));
  } else {
    actions.push(h('button', {
      class: 'btn small danger', onclick: async () => {
        if (!await confirmModal('Delete job', `Delete “${job.name}” with all checkpoints, samples and logs?`)) return;
        try { await api(`/api/training/jobs/${job.id}`, { method: 'DELETE' }); refresh(); }
        catch (e) { toast(e.message, 'error'); }
      },
    }, 'Delete'));
  }
  if (job.status !== 'running' && (job.checkpoints || []).length) {
    actions.push(h('button', {
      class: 'btn small', onclick: () => pushToHFModal(job),
    }, 'Push to HF'));
  }
  actions.push(h('button', {
    class: 'btn small ghost', onclick: async () => {
      try {
        const resp = await apiBlob(`/api/training/jobs/${job.id}/files/train.log`);
        const text = await resp.text();
        const pre = h('pre', { class: 'output', style: 'max-height:60vh' },
          text.slice(-20000) || '(log is empty)');
        modal(`train.log — ${job.name}`, pre, { wide: true });
        pre.scrollTop = pre.scrollHeight;
      } catch (e) {
        toast(e.status === 404 ? 'No log yet for this job (mock runs don’t write one)' : e.message, 'error');
      }
    },
  }, 'View log'));

  const ckpts = h('div', { class: 'list' });
  for (const c of [...(job.checkpoints || [])].reverse()) {
    const sampleRow = h('div', { class: 'row gap' });
    for (const s of (c.samples || []).slice(0, 4)) {
      sampleRow.append(sampleThumb(job.id, { step: c.step, file: s }));
    }
    ckpts.append(h('div', { class: 'list-row' },
      h('span', { class: 'mono', style: 'width:90px' }, `step ${c.step}`),
      h('div', { class: 'grow' }, sampleRow),
      h('button', {
        class: 'btn small ghost', onclick: async (e) => {
          e.target.disabled = true;
          try {
            const path = (c.file.includes('/') ? c.file : `checkpoints/${c.file}`)
              .split('/').map(encodeURIComponent).join('/');
            const resp = await apiBlob(`/api/training/jobs/${job.id}/files/${path}`);
            saveBlob(await resp.blob(), c.file.split('/').pop());
          } catch (err) { toast(err.message, 'error'); }
          e.target.disabled = false;
        },
      }, 'Download'),
      h('button', {
        class: 'btn small ghost', onclick: async () => {
          try {
            const r = await api(`/api/training/jobs/${job.id}/to-loras`, { method: 'POST', body: { checkpoint_file: c.file } });
            toast(`Added to LoRA library as ${r.file}`, 'success');
          } catch (e) { toast(e.message, 'error'); }
        },
      }, 'Use as LoRA')));
  }

  return h('div', { class: 'card', style: 'margin-bottom:14px' },
    h('div', { class: 'row between', style: 'flex-wrap:wrap;gap:8px' },
      h('div', {},
        h('h3', { style: 'margin-bottom:2px' }, job.name),
        h('div', { class: 'muted' },
          `${job.base_model} · dataset ${job.dataset_name} · ${job.steps} steps` +
          ` · rank ${job.rank}/${job.alpha ?? job.rank}` +
          (job.optimizer ? ` · ${job.optimizer} · ${job.lr_scheduler}` : '') +
          (job.trigger_word ? ` · trigger “${job.trigger_word}”` : ''))),
      h('span', { class: `badge ${badgeCls}` }, job.status)),
    h('div', { class: 'progress', style: 'margin:12px 0 6px' }, h('div', { style: `width:${pct}%` })),
    h('div', { class: 'row between muted', style: 'flex-wrap:wrap;gap:6px' },
      h('span', {}, `${job.step || 0} / ${job.steps} steps` +
        (job.loss != null ? ` · loss ${job.loss}` : '') +
        (job.sec_per_step ? ` · ${job.sec_per_step}s/step` : '')),
      h('span', {}, etaText)),
    job.error ? h('p', { class: 'muted', style: 'color:var(--danger)' }, job.error) : null,
    lossChart(job.loss_history || []),
    (job.samples || []).length ? h('div', { class: 'section-gap' },
      h('h3', {}, 'Samples'),
      h('div', { class: 'row gap', style: 'flex-wrap:wrap' },
        (job.samples || []).slice(-12).reverse().map(s => sampleThumb(job.id, s)))) : null,
    job.status === 'running' && liveTails.get(job.id)?.length ? (() => {
      const pre = h('pre', { class: 'output activity' }, liveTails.get(job.id).join('\n'));
      setTimeout(() => { pre.scrollTop = pre.scrollHeight; });
      return h('div', { class: 'section-gap' }, h('h3', {}, 'Activity'), pre);
    })() : null,
    (job.checkpoints || []).length ? h('div', { class: 'section-gap' }, h('h3', {}, 'Checkpoints'), ckpts) : null,
    h('div', { class: 'row gap', style: 'margin-top:12px' }, actions));
}

// Single-series loss line: ink-colored 2px line on the card surface,
// recessive grid, min/max in muted text, direct label on the latest value,
// crosshair tooltip on hover.
function lossChart(history) {
  const W = 600, H = 96, PAD = { l: 6, r: 66, t: 10, b: 8 };
  const pts = history.filter(p => p && p[1] != null);
  if (pts.length < 2) return null;
  const steps = pts.map(p => p[0]), losses = pts.map(p => p[1]);
  const xMin = steps[0], xMax = steps[steps.length - 1];
  const yMin = Math.min(...losses), yMax = Math.max(...losses);
  const ySpan = (yMax - yMin) || 1e-9;
  const X = s => PAD.l + (s - xMin) / ((xMax - xMin) || 1) * (W - PAD.l - PAD.r);
  const Y = v => PAD.t + (1 - (v - yMin) / ySpan) * (H - PAD.t - PAD.b);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const last = pts[pts.length - 1];

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'loss-chart');
  svg.innerHTML = `
    <line x1="${PAD.l}" y1="${Y(yMin)}" x2="${W - PAD.r}" y2="${Y(yMin)}" stroke="#E6E6EB" stroke-width="1"/>
    <line x1="${PAD.l}" y1="${Y(yMax)}" x2="${W - PAD.r}" y2="${Y(yMax)}" stroke="#E6E6EB" stroke-width="1"/>
    <text x="${W - PAD.r + 6}" y="${Y(yMax) + 4}" class="chart-label">${yMax.toFixed(3)}</text>
    <text x="${W - PAD.r + 6}" y="${Y(yMin) + 4}" class="chart-label">${yMin.toFixed(3)}</text>
    <path d="${d}" fill="none" stroke="#111111" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${X(last[0])}" cy="${Y(last[1])}" r="3" fill="#111111"/>
    <text x="${W - PAD.r + 6}" y="${Math.max(PAD.t + 8, Math.min(H - 4, Y(last[1]) + 4))}" class="chart-label chart-label-strong">${last[1].toFixed(4)}</text>`;
  const hoverDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  hoverDot.setAttribute('r', '3.5'); hoverDot.setAttribute('fill', '#111111');
  hoverDot.setAttribute('stroke', '#FFFFFF'); hoverDot.setAttribute('stroke-width', '2');
  hoverDot.style.display = 'none';
  svg.append(hoverDot);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const wrap = h('div', { class: 'loss-chart-wrap' },
    h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:2px' }, 'loss'), svg, tip);
  svg.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const step = xMin + (e.clientX - rect.left) / rect.width * (xMax - xMin);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - step) < Math.abs(pts[best][0] - step)) best = i;
    const p = pts[best];
    hoverDot.setAttribute('cx', X(p[0])); hoverDot.setAttribute('cy', Y(p[1]));
    hoverDot.style.display = '';
    tip.hidden = false;
    tip.textContent = `step ${p[0]} · loss ${p[1].toFixed(4)}`;
    tip.style.left = `${Math.min(rect.width - 130, Math.max(0, e.clientX - rect.left + 8))}px`;
  });
  svg.addEventListener('mouseleave', () => { hoverDot.style.display = 'none'; tip.hidden = true; });
  return wrap;
}

function sampleThumb(jobId, s) {
  const key = `${jobId}/${s.file}`;
  const img = h('img', { class: 'ckpt-sample', alt: s.file, title: s.step != null ? `step ${s.step}` : s.file });
  const attach = (url) => {
    img.src = url;
    img.onclick = () => lightbox(url, { metaEl: h('span', {}, s.step != null ? `step ${s.step}` : s.file) });
  };
  if (sampleURLs.has(key)) attach(sampleURLs.get(key));
  else {
    const path = s.file.split('/').map(encodeURIComponent).join('/');
    apiBlob(`/api/training/jobs/${jobId}/files/${path}`).then(r => r.blob()).then(b => {
      const url = URL.createObjectURL(b);
      sampleURLs.set(key, url);
      attach(url);
    }).catch(() => img.remove());
  }
  return img;
}

function saveBlob(blob, filename) {
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}

function pushToHFModal(job) {
  const repo = h('input', { type: 'text', value: job.hf_push?.repo_id || '', placeholder: 'user/my-lora' });
  const priv = h('input', { type: 'checkbox', checked: job.hf_push?.private ?? true });
  const go = h('button', {
    class: 'btn', onclick: async () => {
      if (!repo.value.trim()) return;
      go.disabled = true;
      try {
        const keys = await getApiKeys();
        if (!keys.hf_key) {
          toast('Save a write-scoped Hugging Face token in Settings first', 'error', 6000);
          go.disabled = false;
          return;
        }
        await api(`/api/training/jobs/${job.id}/push`, {
          method: 'POST',
          body: { repo_id: repo.value.trim(), private: priv.checked, hf_key: keys.hf_key },
        });
        toast('Upload started — watch the toasts for progress');
        m.close();
      } catch (e) { toast(e.message, 'error'); go.disabled = false; }
    },
  }, 'Push checkpoints');
  const m = modal(`Push “${job.name}” to Hugging Face`, h('div', {},
    h('p', { class: 'muted' },
      `Uploads all ${job.checkpoints.length} checkpoint file(s). Uses the HF token from Settings (needs write scope); the token is sent transiently and never stored server-side.`),
    h('label', { class: 'field' }, h('span', {}, 'Repo'), repo),
    h('label', { class: 'row gap', style: 'margin-bottom:14px' }, priv, h('span', {}, 'Private repo')),
    go));
}

function fmtDuration(s) {
  s = Math.max(0, Math.round(s));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}
