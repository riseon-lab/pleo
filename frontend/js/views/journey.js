// Guided creation, using the same authenticated queue and encrypted assets as the workspace.
import { api, apiBlob, onEvent } from '../api.js';
import { h, clear, toast } from '../ui.js';
import { decryptedAssetURL, saveReferenceAsset, saveGeneratedResult } from './assets.js';

const steps = ['Character', 'Sound', 'Motion', 'Frame', 'Create'];
// Deliberately memory-only: prompts and decrypted media must not enter localStorage.
const draft = { step: 0, character: null, description: '', outfit: 'Silver streetwear', cast: 'Solo dancer', style: 'Hip-hop', energy: 'Confident and fluid', scene: 'A midnight-blue studio with neon lighting', camera: 'Full-body tracking shot', aspect: '9:16', seconds: 5, audio: null, audioStart: 0, lyrics: '', driving: null, model: '', imageModel: '', lora: '', prompt: '', job: null, result: null };
const b64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.length; i += 32768) str += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(str);
};
export function buildPrompt(d) {
  return `${d.cast}. ${d.style} dance, ${d.energy.toLowerCase()}. ${d.scene}. ${d.camera}. Preserve the reference character's face, clothing and proportions. Natural coordinated movement, consistent anatomy, continuous shot.`;
}

export async function render(root) {
  const [catalog, library, loraList] = await Promise.all([api('/api/models'), api('/api/assets'), api('/api/loras')]);
  const models = catalog.models;
  const images = models.filter(m => m.kind === 'txt2img');
  const videos = models.filter(m => ['img2video', 'motion2video', 'video2video'].includes(m.kind));
  if (!images.some(m => m.id === draft.imageModel)) draft.imageModel = images[0]?.id || '';
  if (!videos.some(m => m.id === draft.model)) draft.model = videos[0]?.id || '';
  let disposed = false, busy = false, timer = null;
  const assets = library.assets.filter(a => (a.mime || 'image/png').startsWith('image/'));
  const content = h('section', { class: 'journey-content' });
  const progress = h('nav', { class: 'journey-steps', 'aria-label': 'Creation stages' });
  const status = h('p', { class: 'journey-status', role: 'status', 'aria-live': 'polite' });
  const cancel = h('button', { class: 'btn ghost', hidden: true, onclick: async () => {
    if (!draft.job) return;
    try { await api(`/api/jobs/${draft.job.id}/cancel`, { method: 'POST' }); status.textContent = 'Cancellation requested…'; }
    catch (e) { toast(e.message, 'error'); }
  } }, 'Cancel generation');
  const footer = h('footer', { class: 'journey-actions' });
  root.append(h('header', { class: 'journey-header' }, h('a', { href: '#/running', class: 'workspace-link' }, '← Classic workspace'), h('span', { class: 'eyebrow' }, 'THE CREATION JOURNEY'), h('a', { href: '#/assets' }, 'Your library')), progress, content, status, cancel, footer);
  if (catalog.mock) root.prepend(h('p', { class: 'mock-notice' }, 'Preview mode · renders are test media, not AI-generated dance videos.'));

  function field(label, key, { multiline = false, ...attrs } = {}) {
    const input = h(multiline ? 'textarea' : 'input', { type: multiline ? null : 'text', ...attrs, oninput: e => { draft[key] = e.target.type === 'number' ? Number(e.target.value) : e.target.value; if (['style', 'energy', 'scene', 'camera', 'cast'].includes(key)) draft.prompt = ''; } });
    input.value = draft[key];
    return h('label', { class: 'field' }, h('span', {}, label), input);
  }
  function choices(key, values) {
    return h('div', { class: 'choice-row' }, values.map(v => h('button', { class: `choice ${draft[key] === v ? 'selected' : ''}`, 'aria-pressed': draft[key] === v, onclick: () => { draft[key] = v; draft.prompt = ''; draw(); } }, v)));
  }
  function selectModel(key, options) {
    return h('select', { 'aria-label': key === 'model' ? 'Video engine' : 'Character image engine', onchange: e => { draft[key] = e.target.value; draw(); } }, options.map(m => h('option', { value: m.id, selected: draft[key] === m.id }, m.name)));
  }
  function upload(label, accept, key, maxMB) {
    async function load(file) {
      if (!file) return;
      if (file.size > maxMB * 1024 * 1024) return toast(`Choose a file smaller than ${maxMB} MB`, 'error');
      const types = key === 'character' ? ['image/png', 'image/jpeg', 'image/webp'] : key === 'audio' ? ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave'] : ['video/mp4'];
      if (!types.includes(file.type)) return toast('Choose a supported file type', 'error');
      const bytes = await file.arrayBuffer();
      let url = URL.createObjectURL(file);
      try {
        if (key === 'character') {
          const img = new Image(); img.src = url; await img.decode();
          await saveReferenceAsset(bytes, file.name, file.type);
        }
        if (draft[key]?.owned) URL.revokeObjectURL(draft[key].url);
        draft[key] = { name: file.name, url, bytes, mime: file.type, owned: true };
        draw();
      } catch (e) { URL.revokeObjectURL(url); toast(e.message, 'error'); }
    }
    return h('label', { class: 'upload-panel', ondragover: e => e.preventDefault(), ondrop: e => { e.preventDefault(); load(e.dataTransfer.files[0]).catch(e => toast(e.message, 'error')); } },
      h('strong', {}, label), h('span', { class: 'muted' }, draft[key]?.name || `Drop a file here or browse · up to ${maxMB} MB`),
      h('input', { type: 'file', accept, 'aria-label': label, onchange: e => load(e.target.files[0]).catch(e => toast(e.message, 'error')) }));
  }
  function heading(kicker, title, description) {
    return h('div', { class: 'stage-heading' }, h('p', { class: 'eyebrow' }, kicker), h('h1', { tabindex: '-1' }, title), h('p', { class: 'muted' }, description));
  }
  function draw() {
    if (disposed) return;
    clear(progress).append(...steps.map((name, i) => h('button', { class: `journey-step ${i === draft.step ? 'active' : ''}`, 'aria-current': i === draft.step ? 'step' : null, disabled: busy, onclick: () => { draft.step = i; draw(); } }, h('span', {}, String(i + 1).padStart(2, '0')), name)));
    cancel.hidden = !busy || !draft.job;
    clear(content); clear(footer);
    if (draft.step === 0) characterStage();
    if (draft.step === 1) soundStage();
    if (draft.step === 2) motionStage();
    if (draft.step === 3) frameStage();
    if (draft.step === 4) reviewStage();
    footer.append(h('span', { class: 'muted' }, `STAGE ${draft.step + 1} OF 5`), h('div', { class: 'row gap' },
      draft.step > 0 ? h('button', { class: 'btn ghost', disabled: busy, onclick: () => move(-1) }, 'Back') : null,
      draft.step < 4 ? h('button', { class: 'btn', disabled: busy, onclick: () => move(1) }, `Continue to ${steps[draft.step + 1].toLowerCase()} →`) : null));
    if (busy) content.querySelectorAll('button,input,select,textarea').forEach(el => { el.disabled = true; });
  }
  function move(delta) {
    if (delta > 0 && draft.step === 0 && !draft.character) return toast('Choose or create a character first', 'error');
    draft.step += delta; draw(); content.querySelector('h1')?.focus();
  }
  function characterStage() {
    content.append(heading('01 / CAST YOUR LEAD', 'Every story starts with a character.', 'Choose a saved frame, upload a portrait, or create someone new. Full-body references work best for dancing.'));
    const cast = h('div', { class: 'character-grid' });
    if (draft.character) cast.append(h('div', { class: 'character-card selected' }, h('img', { src: draft.character.url, alt: 'Selected character' }), h('div', {}, h('strong', {}, draft.character.name), h('span', {}, 'Selected character'))));
    for (const asset of assets.slice(0, 20)) {
      const img = h('img', { alt: 'Saved character reference', loading: 'lazy' });
      const button = h('button', { class: 'character-card', onclick: async () => {
        try {
          const url = await decryptedAssetURL(asset.id, asset.mime);
          const bytes = await (await fetch(url)).arrayBuffer();
          if (draft.character?.owned) URL.revokeObjectURL(draft.character.url);
          draft.character = { name: 'Saved character', url, bytes, mime: asset.mime || 'image/png' }; draw();
        } catch (e) { toast(e.message, 'error'); }
      } }, img, h('div', {}, h('strong', {}, 'From your library'), h('span', {}, 'Select this frame')));
      decryptedAssetURL(asset.id, asset.mime).then(url => { if (!disposed) img.src = url; }).catch(() => button.remove());
      cast.append(button);
    }
    content.append(cast, h('div', { class: 'journey-columns' },
      h('div', { class: 'glass-panel' }, h('h2', {}, 'Bring your character'), upload('Upload a character', 'image/png,image/jpeg,image/webp', 'character', 32), choices('cast', ['Solo dancer', 'Duo / backup dancers']), h('p', { class: 'muted' }, 'For a duo, use a reference showing both characters. A prompt alone cannot guarantee a second identity.')),
      h('div', { class: 'glass-panel' }, h('h2', {}, 'Create a new character'), field('Describe your character', 'description', { multiline: true, placeholder: 'An adult dancer with short dark hair and a confident stance…', maxlength: 4000 }), field('Outfit', 'outfit'), choices('outfit', ['Silver streetwear', 'Black performance wear', 'Electric-blue tailoring']), selectModel('imageModel', images),
        h('label', { class: 'field' }, h('span', {}, 'Character LoRA (optional; must match the image engine)'), h('select', { onchange: e => { draft.lora = e.target.value; } }, h('option', { value: '' }, 'No LoRA'), loraList.loras.map(l => h('option', { value: l.file, selected: draft.lora === l.file }, l.label)))),
        h('button', { class: 'btn', disabled: busy || !images.length, onclick: createCharacter }, 'Generate character'))));
  }
  function soundStage() {
    content.append(heading('02 / FIND YOUR SOUND', 'Give the scene a soundtrack.', 'Choose your track and the moment it starts. You can also make a silent dance clip.'));
    content.append(h('div', { class: 'journey-columns' }, h('div', { class: 'glass-panel' }, upload('Upload MP3 or WAV', '.mp3,.wav,audio/mpeg,audio/wav', 'audio', 32),
      draft.audio ? h('audio', { src: draft.audio.url, controls: true, preload: 'metadata' }) : null,
      field('Start at (seconds)', 'audioStart', { type: 'number', min: 0, max: 3600, step: 0.1 }),
      draft.audio ? h('button', { class: 'btn ghost', onclick: () => { URL.revokeObjectURL(draft.audio.url); draft.audio = null; draw(); } }, 'Remove soundtrack') : null),
      h('div', { class: 'glass-panel' }, field('Lyrics / timing notes', 'lyrics', { multiline: true, placeholder: 'Add the lyric or moment you want to build around…', maxlength: 4000 }), h('p', { class: 'muted' }, 'Notes stay in this tab. The track is mixed into the finished video; automatic lyric alignment, beat detection and lip-sync are not connected yet.'), h('span', { class: 'badge' }, 'Dance only · soundtrack optional'))));
  }
  function motionStage() {
    content.append(heading('03 / FIND THE MOVEMENT', 'What does the moment feel like?', 'Start with a suggestion, then make it your own. We turn your choices into a direction prompt.'));
    content.append(h('div', { class: 'journey-columns' }, h('div', { class: 'glass-panel' }, field('Dance style', 'style'), choices('style', ['Hip-hop', 'Shuffle', 'Contemporary', 'House', 'Afrobeats']), field('Energy', 'energy'), choices('energy', ['Confident and fluid', 'Fast and explosive', 'Slow and expressive']), field('Scene', 'scene', { multiline: true })),
      h('div', { class: 'glass-panel' }, h('h2', {}, 'Choose how to move'), selectModel('model', videos), h('p', { class: 'muted' }, 'Image-to-video follows your prompt. Motion transfer and video-to-video need a driving clip.'),
        ['motion2video', 'video2video'].includes(videos.find(m => m.id === draft.model)?.kind) ? upload('Upload driving MP4', 'video/mp4', 'driving', 64) : null,
        h('p', { class: 'muted' }, 'Wan uses your configured GPU. Higgsfield is not connected.'), h('a', { class: 'workspace-link', href: '#/models' }, 'Manage engines in the workspace →'))));
  }
  function frameStage() {
    content.append(heading('04 / DIRECT THE FRAME', 'Small screen. Or the big picture.', 'Choose the stage for your performance. A centre crop sets the frame; keep the dancer in view.'));
    content.append(h('div', { class: 'journey-columns' }, h('div', { class: 'glass-panel' }, choices('aspect', ['9:16', '16:9']), h('p', { class: 'muted' }, draft.aspect === '9:16' ? 'Portrait · TikTok, Reels and Shorts' : 'Landscape · full-stage films and wider choreography'), field('Camera direction', 'camera'), choices('camera', ['Full-body tracking shot', 'Locked wide shot', 'Slow push-in']), h('label', { class: 'field' }, h('span', {}, 'Clip duration'), h('select', { onchange: e => { draft.seconds = +e.target.value; } }, [3, 4, 5, 6, 7, 8].map(n => h('option', { value: n, selected: draft.seconds === n }, `${n} seconds`)))), h('p', { class: 'muted' }, '480p keeps the first render lighter. More output controls are available in the classic workspace.')),
      h('div', { class: 'framing-panel' }, draft.character ? h('img', { class: 'framing-preview', style: `aspect-ratio:${draft.aspect.replace(':', '/')}`, src: draft.character.url, alt: 'Centre-crop framing preview' }) : h('p', { class: 'muted' }, 'Choose a character to preview the frame.'))));
  }
  function reviewStage() {
    content.append(heading('05 / YOUR DIRECTOR’S CUT', 'Ready when you are.', 'Review your direction, then send it to your generation queue.'));
    const model = videos.find(m => m.id === draft.model);
    const result = draft.result;
    content.append(h('div', { class: 'journey-columns' }, h('div', { class: 'glass-panel' },
      h('p', { class: 'eyebrow' }, `${draft.aspect} / ${draft.seconds} SECONDS / ${draft.cast.toUpperCase()}`),
      h('p', {}, draft.character?.name || 'No character selected'),
      h('p', { class: 'muted' }, draft.audio ? `${draft.audio.name} · starts at ${draft.audioStart}s` : 'Silent dance clip'),
      h('label', { class: 'field' }, h('span', {}, 'Your direction prompt'), h('textarea', { class: 'direction-prompt', maxlength: 8000, oninput: e => { draft.prompt = e.target.value; } }, draft.prompt || buildPrompt(draft))),
      h('p', { class: 'muted' }, model?.name || 'No video engine configured'),
      model && !catalog.mock && model.env !== 'ready' ? h('p', { class: 'muted' }, 'Set up this engine on the Models page before rendering.') : null,
      h('button', { class: 'btn render-btn', disabled: busy || !draft.character || !model || (!catalog.mock && model.env !== 'ready'), onclick: createVideo }, busy ? 'Creating…' : 'Create dance video →'),
      h('p', { class: 'muted' }, 'Prompt-led motion is approximate. Soundtrack mixing does not synchronise steps to beats.')),
      h('div', { class: 'result-panel' }, result ? h('video', { src: result.url, controls: true, playsinline: true, 'aria-label': 'Finished dance video' }) : draft.character ? h('img', { src: draft.character.url, alt: 'Your starting frame' }) : null,
        result ? h('a', { class: 'btn', href: result.url, download: 'dance-video.mp4' }, 'Download video') : h('p', { class: 'muted' }, 'Your finished film will appear here.'),
        result ? h('p', { class: 'muted' }, result.saved ? 'Saved to your encrypted library.' : 'Video is ready. Library save failed; download it now or recover it in the classic queue.') : null)));
  }
  async function createCharacter() {
    if (!draft.description.trim()) return toast('Describe your character first', 'error');
    const model = images.find(m => m.id === draft.imageModel);
    if (!model) return;
    await submit({ model_id: model.id, ...model.defaults, width: 576, height: 1024, prompt: `${draft.description}. ${draft.outfit}. ${draft.cast}. Full body, feet visible, neutral standing pose, cinematic blue studio lighting.`, loras: draft.lora ? [{ file: draft.lora, strength: 1 }] : [] }, 'character');
  }
  async function createVideo() {
    const model = videos.find(m => m.id === draft.model);
    if (!draft.character || !model) return;
    const driven = model.kind !== 'img2video';
    if (driven && !draft.driving) return toast('Add a driving video in the Motion stage', 'error');
    if (!Number.isFinite(draft.audioStart) || draft.audioStart < 0 || draft.audioStart > 3600) return toast('Choose a soundtrack start between 0 and 3600 seconds', 'error');
    const fps = driven ? model.video.output_fps : model.defaults.fps;
    const multiple = model.video.frame_multiple || 1;
    const frames = Math.min(model.video.max_frames || 193, Math.floor(draft.seconds * fps / multiple) * multiple + 1);
    await submit({ ...model.defaults, model_id: model.id, prompt: draft.prompt || buildPrompt(draft), video_tier: '480p', video_aspect: draft.aspect,
      width: draft.aspect === '9:16' ? 432 : 768, height: draft.aspect === '9:16' ? 768 : 432,
      fps, num_frames: frames, ref_image_b64: b64(draft.character.bytes),
      ...(driven ? { ref_video_b64: b64(draft.driving.bytes) } : {}),
      ...(draft.audio ? { audio_b64: b64(draft.audio.bytes), audio_start: draft.audioStart } : {}) }, 'video');
  }
  async function submit(body, kind) {
    if (busy) return;
    busy = true; status.textContent = 'Submitting to your queue…'; draw();
    try {
      const response = await api('/api/generate', { method: 'POST', body: { ...body, release_after_generate: true } });
      draft.job = { id: response.job.id, kind }; cancel.hidden = false; poll();
    } catch (e) { busy = false; status.textContent = e.message; draw(); }
  }
  async function poll() {
    if (disposed || !draft.job) return;
    try {
      const queue = await api('/api/queue');
      const job = [queue.current, ...queue.queued, ...queue.history].find(j => j?.id === draft.job.id);
      if (!job) throw new Error('Job is no longer in the queue. Check your library or start again.');
      status.textContent = `${draft.job.kind === 'character' ? 'Character' : 'Video'} · ${job.status}${job.error ? ` · ${job.error}` : ''}`;
      if (job.status === 'done') {
        const kind = draft.job.kind;
        let bytes, url, meta = {}, saved = Boolean(job.asset_id);
        if (job.asset_id) {
          url = await decryptedAssetURL(job.asset_id, job.mime);
          bytes = await (await fetch(url)).arrayBuffer();
        } else {
          const response = await apiBlob(`/api/results/${job.result_id}`);
          bytes = await response.arrayBuffer();
          const raw = response.headers.get('x-pleo-meta-plain');
          if (raw) meta = JSON.parse(atob(raw));
          url = URL.createObjectURL(new Blob([bytes], { type: job.mime }));
          try { await saveGeneratedResult(job, bytes, meta, job.mime); saved = true; }
          catch (e) { toast(`Library save failed: ${e.message}`, 'error'); }
        }
        if (kind === 'character') {
          if (draft.character?.owned) URL.revokeObjectURL(draft.character.url);
          draft.character = { name: 'Your new character', url, bytes, mime: job.mime, owned: !job.asset_id };
        } else {
          if (draft.result?.owned) URL.revokeObjectURL(draft.result.url);
          draft.result = { url, saved, owned: !job.asset_id };
        }
        draft.job = null; busy = false; status.textContent = saved ? 'Ready · saved to your encrypted library.' : 'Ready · download available; library save needs attention.'; draw(); return;
      }
      if (['error', 'blocked', 'cancelled'].includes(job.status)) { draft.job = null; busy = false; draw(); return; }
    } catch (e) { status.textContent = e.message; busy = false; draft.job = null; draw(); return; }
    if (!disposed) timer = setTimeout(poll, 1500);
  }
  const off = onEvent(e => { if (e.type === 'step' && e.job_id === draft.job?.id) status.textContent = `${e.stage || 'Generating'}${e.total ? ` · ${e.step}/${e.total}` : ''}`; });
  if (draft.job) { busy = true; poll(); }
  draw();
  return () => { disposed = true; clearTimeout(timer); off(); root.querySelectorAll('audio,video').forEach(el => el.pause()); };
}
