// Training: LoRA jobs — config, live progress, checkpoints with samples,
// ETA + cost from your RunPod hourly rate, push to HF, promote to LoRAs.
import { api, apiBlob, onEvent } from '../api.js';
import { h, clear, toast, confirmModal, fmtBytes, lightbox } from '../ui.js';
import { getApiKeys } from './settings.js';

const RATE_KEY = 'pleo-runpod-rate';

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
    if (ev.type === 'training') {
      const i = jobList.findIndex(j => j.id === ev.job.id);
      if (i >= 0) jobList[i] = ev.job; else jobList.unshift(ev.job);
      drawJobs();
    }
    if (ev.type === 'training_push') {
      if (ev.status === 'done') toast(`Pushed to HF: ${ev.repo}`, 'success');
      if (ev.status === 'error') toast(`HF push failed: ${ev.detail}`, 'error');
      if (ev.status === 'skipped') toast('HF push skipped (mock mode)');
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
  const card = h('div', { class: 'card', style: 'margin-bottom:16px' },
    h('h3', {}, 'Trainer environment'),
    h('p', { class: 'muted' },
      'Isolated venv for ai-toolkit. Also clone it on the volume once: git clone https://github.com/ostris/ai-toolkit /workspace/ai-toolkit'),
    h('div', { class: 'row gap', style: 'flex-wrap:wrap' }, status, createBtn, deleteBtn, detail));

  card.refresh = async () => {
    const envs = await api('/api/envs');
    const s = envs.trainer || { status: 'none', detail: '' };
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
    h('label', { class: 'field' }, h('span', {}, 'Total steps'), steps, stepsHint),
    h('label', { class: 'field' }, h('span', {}, 'Checkpoint saves (steps, comma-separated — manual saves any time)'), checkpoints),
    h('label', { class: 'field' }, h('span', {}, 'Checkpoint sample prompts'), samples),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, 'LoRA rank'), rank),
      h('label', { class: 'field' }, h('span', {}, 'LoRA alpha'), alpha),
      h('label', { class: 'field' }, h('span', {}, 'Learning rate'), lr),
      h('label', { class: 'field' }, h('span', {}, 'LR scheduler'), scheduler),
      h('label', { class: 'field' }, h('span', {}, 'Optimizer'), optimizer),
      h('label', { class: 'field' }, h('span', {}, 'Resolution'), resolution),
      h('label', { class: 'field' }, h('span', {}, 'Batch size'), batch)),
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

  const ckpts = h('div', { class: 'list' });
  for (const c of [...(job.checkpoints || [])].reverse()) {
    const sampleRow = h('div', { class: 'row gap' });
    for (const s of (c.samples || []).slice(0, 4)) {
      const img = h('img', { class: 'ckpt-sample', alt: s });
      apiBlob(`/api/training/jobs/${job.id}/files/samples/${encodeURIComponent(s)}`)
        .then(r => r.blob()).then(b => {
          img.src = URL.createObjectURL(b);
          img.onclick = () => lightbox(img.src, { metaEl: h('span', {}, `step ${c.step}`) });
        }).catch(() => img.remove());
      sampleRow.append(img);
    }
    ckpts.append(h('div', { class: 'list-row' },
      h('span', { class: 'mono', style: 'width:90px' }, `step ${c.step}`),
      h('div', { class: 'grow' }, sampleRow),
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
    (job.checkpoints || []).length ? h('div', { class: 'section-gap' }, h('h3', {}, 'Checkpoints'), ckpts) : null,
    h('div', { class: 'row gap', style: 'margin-top:12px' }, actions));
}

function fmtDuration(s) {
  s = Math.max(0, Math.round(s));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}
