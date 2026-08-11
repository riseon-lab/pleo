// Running view: generation controls, live step viewer, queue, lightbox.
import { api, apiBlob, onEvent } from '../api.js';
import { encryptBytes, encryptJSON } from '../crypto.js';
import { getParams, saveParams, getLoraStack, saveLoraStack, getUI, saveUI } from '../state.js';
import { h, clear, toast, modal, lightbox, confirmModal, fmtBytes } from '../ui.js';
import { assetMime, decryptedAssetURL, evictDecryptedAssetURL, saveReferenceAsset } from './assets.js';

// FHD presets are snapped to the models' 16px latent grid (1080 → 1072).
const PRESETS = [
  { label: 'Square 512 × 512', w: 512, h: 512 },
  { label: 'Square 1024 × 1024', w: 1024, h: 1024 },
  { label: 'Portrait 832 × 1216', w: 832, h: 1216 },
  { label: 'Landscape 1216 × 832', w: 1216, h: 832 },
  { label: 'Portrait FHD 1072 × 1920', w: 1072, h: 1920 },
  { label: 'Landscape FHD 1920 × 1072', w: 1920, h: 1072 },
];

const WAN_VIDEO = {
  steps: 4,
  cfg: 1,
  fpsOptions: [12, 16, 20, 24],
  secondsOptions: [3, 4, 5, 6, 7, 8],
  tiers: {
    '480p': { label: '480p', detail: 'Safer · faster', maxArea: 480 * 832 },
    '720p': { label: '720p', detail: 'More detail · higher VRAM', maxArea: 720 * 1280 },
  },
  aspects: {
    source: { label: 'Source', detail: 'Keep framing' },
    '9:16': { label: 'Portrait 9:16', detail: 'Centre crop' },
  },
};
const SOURCE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const collectingResults = new Set();

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
  let loraStack = normalizeStack(getLoraStack(modelId), model.lora_defaults);
  let refFile = null; // transient plaintext source for edit/I2V models
  let videoTier = params.video_tier || model.defaults?.video_tier || '480p';
  let videoAspect = params.video_aspect || model.defaults?.video_aspect || 'source';
  let videoFps = params.fps || model.defaults?.fps || 16;
  let videoSeconds = params.video_seconds || Math.round(((params.num_frames || 81) - 1) / videoFps) || 5;
  let resultObjectURL = null;
  let liveJobId = null;
  let disposed = false;

  // ---------- controls ----------
  const modelSel = h('select', {
    onchange: () => {
      persist();
      modelId = modelSel.value;
      model = models.find(m => m.id === modelId);
      params = getParams(modelId, defaultsOf(model));
      loraStack = normalizeStack(getLoraStack(modelId), model.lora_defaults);
      saveUI({ selectedModel: modelId });
      syncInputs();
    },
  }, models.map(m => h('option', { value: m.id, selected: m.id === modelId }, m.name)));

  const prompt = h('textarea', { class: 'main-prompt', placeholder: 'Prompt…', oninput: persist });
  const promptHelp = h('p', { class: 'muted field-help', hidden: true }, 'Describe the action and camera movement. This distilled CFG 1 profile does not use a negative prompt.');
  const promptField = h('label', { class: 'field' }, h('span', {}, 'Prompt'), prompt, promptHelp);
  const negative = h('textarea', { placeholder: 'Negative prompt (optional)', style: 'min-height:48px', oninput: persist });
  const negativeField = h('label', { class: 'field' }, h('span', {}, 'Negative prompt'), negative);
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

  const stepCfgFields = h('div', { class: 'grid2' },
    h('label', { class: 'field' }, h('span', {}, 'Steps'), steps),
    h('label', { class: 'field' }, h('span', {}, 'CFG scale'), cfg));
  const resolutionField = h('label', { class: 'field' }, h('span', {}, 'Resolution'), presetSel);
  const dimensionFields = h('div', { class: 'grid2' },
    h('label', { class: 'field' }, h('span', {}, 'Width'), width),
    h('label', { class: 'field' }, h('span', {}, 'Height'), height));
  const seedField = h('label', { class: 'field' }, h('span', {}, 'Seed (−1 = random)'), seed);

  function num(attrs) { return h('input', { type: 'number', oninput: persist, ...attrs }); }

  const refInput = h('input', { type: 'file', accept: '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp', onchange: async () => {
    const f = refInput.files[0];
    if (f) await useSourceFile(f);
  } });
  const refField = h('label', { class: 'field' }, h('span', {}, 'Reference image (required for edit models)'), refInput);

  const videoInput = h('input', { type: 'file', accept: '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp', hidden: true, onchange: async () => {
    const f = videoInput.files[0];
    if (f) await useSourceFile(f);
  } });
  const videoSourceImg = h('img', { alt: 'Video start frame', hidden: true });
  const videoSourceEmpty = h('div', { class: 'video-source-empty' }, 'Drop in the frame you want to animate');
  const videoSourceMeta = h('p', { class: 'muted video-source-meta' }, 'JPG, PNG or WebP');
  const videoSourceDrop = h('div', {
    class: 'video-source-drop',
    onclick: () => videoInput.click(),
    ondragover: e => { e.preventDefault(); videoSourceDrop.classList.add('dragging'); },
    ondragleave: () => videoSourceDrop.classList.remove('dragging'),
    ondrop: async e => {
      e.preventDefault();
      videoSourceDrop.classList.remove('dragging');
      const f = [...e.dataTransfer.files].find(file => SOURCE_MIMES.has(sourceMime(file)));
      if (f) await useSourceFile(f);
    },
  }, videoSourceImg, videoSourceEmpty);
  const videoSourceField = h('div', { class: 'field' },
    h('span', {}, 'Start image'), videoSourceDrop, videoSourceMeta,
    h('div', { class: 'row gap video-source-actions' },
      h('button', { class: 'btn ghost small', onclick: () => videoInput.click() }, 'Choose image'),
      h('button', { class: 'btn ghost small', onclick: chooseSourceAsset }, 'Choose from Assets'),
      videoInput));

  const aspectButtons = h('div', { class: 'video-tier', role: 'group', 'aria-label': 'Video framing' }, Object.entries(WAN_VIDEO.aspects).map(([aspect, item]) =>
    h('button', { onclick: () => { videoAspect = aspect; renderVideoAspect(); persist(); syncAspect(); } },
      h('strong', {}, item.label), h('small', {}, item.detail))));
  const videoAspectField = h('div', { class: 'field' }, h('span', {}, 'Framing'), aspectButtons);
  const tierButtons = h('div', { class: 'video-tier' }, Object.entries(WAN_VIDEO.tiers).map(([tier, item]) =>
    h('button', { onclick: () => { videoTier = tier; renderVideoTier(); persist(); syncAspect(); } },
      h('strong', {}, item.label), h('small', {}, item.detail))));
  const videoTierField = h('div', { class: 'field' }, h('span', {}, 'Output tier'), tierButtons);
  const fpsButtons = h('div', { class: 'video-pills video-fps', role: 'group', 'aria-label': 'Frames per second' }, WAN_VIDEO.fpsOptions.map(fps =>
    h('button', { onclick: () => { videoFps = fps; renderVideoTiming(); persist(); } }, `${fps} fps`)));
  const videoFpsField = h('div', { class: 'field' }, h('span', {}, 'Frame rate'), fpsButtons);
  const secondsButtons = h('div', { class: 'video-pills video-seconds', role: 'group', 'aria-label': 'Video duration' }, WAN_VIDEO.secondsOptions.map(seconds =>
    h('button', { onclick: () => { videoSeconds = seconds; renderVideoTiming(); persist(); } }, `${seconds}s`)));
  const videoSecondsField = h('div', { class: 'field' }, h('span', {}, 'Duration'), secondsButtons);
  const videoOutputLine = h('p', { class: 'muted video-output-line' }, 'Output follows the start image aspect ratio.');
  const wanTimingInfo = h('p', {});
  const wanInfo = h('div', { class: 'wan-baked' },
    h('div', { class: 'row between' }, h('strong', {}, 'LightX2V 720p distilled experts'), h('span', { class: 'badge ok' }, 'baked')),
    h('p', {}, '2026 high-noise + low-noise quality checkpoints'),
    wanTimingInfo);
  const wanControls = h('div', { hidden: true }, videoSourceField, videoAspectField, videoTierField,
    videoSecondsField, videoFpsField, videoOutputLine, wanInfo);

  const loraSummary = h('div', { class: 'lora-chiprow' });
  const loraBtn = h('button', { class: 'btn ghost small', onclick: openLoraModal }, 'Manage LoRAs');
  const loraTitle = h('span', {}, 'LoRA stack');
  const loraHelp = h('p', { class: 'muted field-help', hidden: true }, 'Stack up to four files. High and Low are expert stages, not a two-LoRA limit; new imports default to H 0.70 / L 0.50.');
  const loraField = h('div', { class: 'field' },
    loraTitle, loraHelp, loraSummary, h('div', { style: 'margin-top:8px' }, loraBtn));

  const genBtn = h('button', { class: 'btn', style: 'width:100%', onclick: submit }, 'Generate');

  const controls = h('div', { class: 'card' },
    h('label', { class: 'field' }, h('span', {}, 'Model'), modelSel),
    wanControls,
    promptField,
    negativeField,
    stepCfgFields,
    resolutionField,
    dimensionFields,
    seedField,
    refField,
    loraField,
    genBtn);

  // ---------- viewer ----------
  const previewImg = h('img', { alt: 'preview', hidden: true });
  const previewVideo = h('video', { controls: true, playsinline: true, loop: true, preload: 'metadata', hidden: true });
  const previewEmpty = h('div', { class: 'preview-empty' }, 'Generations appear here. Live noise previews stream in step by step.');
  const previewBox = h('div', { class: 'preview-box' }, previewImg, previewVideo, previewEmpty);
  const progressBar = h('div', {});
  const progressWrap = h('div', { class: 'progress', style: 'visibility:hidden' }, progressBar);
  const statusLine = h('div', { class: 'row between' },
    h('span', { class: 'muted', id: 'gen-status' }, 'Idle'),
    h('button', { class: 'btn ghost small', hidden: true, id: 'cancel-btn', onclick: cancelCurrent }, 'Cancel'));
  const viewer = h('div', { class: 'card viewer-card' },
    h('div', { class: 'preview-shell' }, previewBox),
    progressWrap, statusLine);

  const queueList = h('div', { class: 'queue-list' });
  const clearBtn = h('button', {
    class: 'btn small ghost', onclick: async () => {
      try {
        await api('/api/queue/clear', { method: 'POST' });
        toast('Queue history cleared (assets stay in the library)', 'success');
        refreshQueue();
      } catch (e) { toast(e.message, 'error'); }
    },
  }, 'Clear history');
  const queueCard = h('div', { class: 'card section-gap' },
    h('div', { class: 'row between' }, h('h3', {}, 'Queue'), clearBtn), queueList);

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
      video_tier: videoTier,
      video_aspect: videoAspect,
      video_seconds: videoSeconds,
      num_frames: videoFrameCount(),
      fps: videoFps,
    });
  }

  function syncInputs() {
    const isVideo = model.kind === 'img2video';
    prompt.value = params.prompt ?? '';
    negative.value = params.negative ?? '';
    steps.value = params.steps ?? 4;
    cfg.value = params.cfg ?? 1;
    seed.value = params.seed ?? -1;
    width.value = params.width ?? 1024;
    height.value = params.height ?? 1024;
    videoTier = params.video_tier || model.defaults?.video_tier || '480p';
    videoAspect = params.video_aspect || model.defaults?.video_aspect || 'source';
    videoFps = WAN_VIDEO.fpsOptions.includes(+params.fps) ? +params.fps : model.defaults?.fps || 16;
    const savedSeconds = params.video_seconds || Math.round(((params.num_frames || 81) - 1) / videoFps);
    videoSeconds = WAN_VIDEO.secondsOptions.includes(+savedSeconds) ? +savedSeconds : 5;
    const p = PRESETS.find(p => p.w === +width.value && p.h === +height.value);
    presetSel.value = p ? p.label : 'custom';
    wanControls.hidden = !isVideo;
    promptHelp.hidden = !isVideo;
    negativeField.hidden = isVideo;
    stepCfgFields.hidden = isVideo;
    resolutionField.hidden = isVideo;
    dimensionFields.hidden = isVideo;
    refField.style.display = model.kind === 'edit' ? '' : 'none';
    loraField.hidden = false;
    loraTitle.textContent = isVideo ? `Wan LoRA stack · up to ${wanLoraDefaults(model).maxStack}` : 'LoRA stack';
    loraHelp.hidden = !isVideo;
    genBtn.textContent = isVideo ? 'Generate video' : 'Generate';
    previewEmpty.textContent = isVideo
      ? 'Your video appears here. The start frame stays visible while Wan works.'
      : 'Generations appear here. Live noise previews stream in step by step.';
    renderVideoTier();
    renderVideoAspect();
    renderVideoTiming();
    renderVideoSource();
    renderLoraSummary();
    syncAspect();
  }

  function syncAspect() {
    if (model.kind === 'img2video') {
      previewBox.style.aspectRatio = videoAspect === '9:16' ? '9 / 16' : refFile?.width && refFile?.height
        ? `${refFile.width} / ${refFile.height}` : '16 / 9';
    } else {
      previewBox.style.aspectRatio = `${+width.value || 16} / ${+height.value || 9}`;
    }
    previewImg.style.objectFit = model.kind === 'img2video' && videoAspect === '9:16' ? 'cover' : 'contain';
  }

  function renderVideoTier() {
    [...tierButtons.children].forEach((button, i) => {
      button.classList.toggle('selected', Object.keys(WAN_VIDEO.tiers)[i] === videoTier);
    });
    renderVideoSource();
  }

  function renderVideoAspect() {
    [...aspectButtons.children].forEach((button, i) => {
      const selected = Object.keys(WAN_VIDEO.aspects)[i] === videoAspect;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected);
    });
    videoSourceDrop.classList.toggle('portrait', videoAspect === '9:16');
    renderVideoSource();
  }

  function videoFrameCount() { return videoSeconds * videoFps + 1; }

  function renderVideoTiming() {
    [...fpsButtons.children].forEach((button, i) => {
      const selected = WAN_VIDEO.fpsOptions[i] === videoFps;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected);
    });
    [...secondsButtons.children].forEach((button, i) => {
      const selected = WAN_VIDEO.secondsOptions[i] === videoSeconds;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected);
    });
    const frames = videoFrameCount();
    wanTimingInfo.textContent = `CFG 1 / 1 · 4 steps · ${frames} frames · ${videoFps} fps · ${videoSeconds}s${frames > 81 ? ' · long clip: more VRAM' : ''}`;
    if (model.kind === 'img2video') genBtn.textContent = `Generate ${videoSeconds}s video`;
  }

  function renderVideoSource() {
    const ready = Boolean(refFile?.url);
    videoSourceImg.hidden = !ready;
    videoSourceEmpty.hidden = ready;
    if (ready) videoSourceImg.src = refFile.url;
    if (!refFile) {
      videoSourceMeta.textContent = 'JPG, PNG or WebP';
      videoOutputLine.textContent = videoAspect === '9:16'
        ? `${videoTier} tier · portrait 9:16 · centre crop`
        : 'Output follows the start image aspect ratio.';
      return;
    }
    const size = wanOutputSize();
    videoSourceMeta.textContent = `${refFile.name}${refFile.width ? ` · ${refFile.width}×${refFile.height}` : ''}`;
    videoOutputLine.textContent = size
      ? `${videoTier} tier · ${size.width}×${size.height} output · ${videoAspect === '9:16' ? 'portrait centre crop' : 'source aspect preserved'}`
      : `${videoTier} tier · source aspect preserved`;
  }

  function wanOutputSize() {
    if (videoAspect !== '9:16' && (!refFile?.width || !refFile?.height)) return null;
    return wanOutputSizeFor(refFile?.width || 9, refFile?.height || 16);
  }

  function wanOutputSizeFor(sourceWidth, sourceHeight) {
    const area = (WAN_VIDEO.tiers[videoTier] || WAN_VIDEO.tiers['480p']).maxArea;
    if (videoAspect === '9:16') {
      const unit = Math.floor(Math.sqrt(area / (9 * 16)) / 16) * 16;
      return { width: 9 * unit, height: 16 * unit };
    }
    const ratio = sourceHeight / sourceWidth;
    const height = Math.floor(Math.round(Math.sqrt(area * ratio)) / 16) * 16;
    const width = Math.floor(Math.round(Math.sqrt(area / ratio)) / 16) * 16;
    return { width, height };
  }

  async function useSourceFile(file) {
    const mime = sourceMime(file);
    if (!SOURCE_MIMES.has(mime)) return toast('Choose a JPG, PNG or WebP image', 'error');
    if (file.size > MAX_SOURCE_BYTES) return toast('Start image must be 32 MB or smaller', 'error');
    try {
      const bytes = await file.arrayBuffer();
      await setSource(bytes, file.name, mime, null, true);
    } catch (e) { toast(`Could not use image: ${e.message}`, 'error'); }
  }

  async function setSource(bytes, name, mime, existingURL = null, save = false) {
    const url = existingURL || URL.createObjectURL(new Blob([bytes], { type: mime }));
    let dimensions;
    try {
      dimensions = await imageDimensions(url);
      if (dimensions.width * dimensions.height > 64_000_000) throw new Error('Image has too many pixels');
      if (model.kind === 'img2video') {
        const size = wanOutputSizeFor(dimensions.width, dimensions.height);
        if (Math.min(size.width, size.height) < 64 || Math.max(size.width, size.height) > 2048) {
          throw new Error('Image aspect ratio is too extreme for Wan video');
        }
      }
      if (save) await saveReferenceAsset(bytes, name, mime);
    }
    catch (e) {
      if (!existingURL) URL.revokeObjectURL(url);
      throw e;
    }
    if (refFile?.ownedURL && refFile.url) URL.revokeObjectURL(refFile.url);
    refFile = {
      b64: bufToB64(bytes), name, mime, url,
      width: dimensions.width, height: dimensions.height,
      ownedURL: !existingURL,
    };
    renderVideoSource();
    syncAspect();
    if (save) toast(`${name} saved to Assets (encrypted)`, 'success');
  }

  async function chooseSourceAsset() {
    try {
      const { assets } = await api('/api/assets');
      const images = assets.filter(a => SOURCE_MIMES.has(assetMime(a)));
      if (!images.length) return toast('No image assets available', 'error');
      const grid = h('div', { class: 'asset-grid source-asset-grid' });
      const picker = modal('Choose start image', grid, { wide: true });
      for (const a of images.slice(0, 60)) {
        const img = h('img', { alt: a.kind, loading: 'lazy' });
        const tile = h('button', { class: 'asset-tile source-asset-tile', onclick: async () => {
          try {
            const url = img.src || await decryptedAssetURL(a.id, assetMime(a));
            const bytes = await (await fetch(url)).arrayBuffer();
            await setSource(bytes, `asset-${a.id}`, assetMime(a), url);
            picker.close();
          } catch (e) { toast(`Could not use asset: ${e.message}`, 'error'); }
        } }, img, h('span', { class: 'badge tag' }, a.kind));
        grid.append(tile);
        decryptedAssetURL(a.id, assetMime(a)).then(url => { img.src = url; }).catch(() => tile.remove());
      }
    } catch (e) { toast(e.message, 'error'); }
  }

  function renderLoraSummary() {
    clear(loraSummary);
    if (!loraStack.length) loraSummary.append(h('span', { class: 'muted' }, 'None imported'));
    for (const l of loraStack) {
      loraSummary.append(h('span', { class: `lora-chip${l.enabled ? '' : ' off'}` },
        model.kind === 'img2video'
          ? `${l.enabled ? '' : '⏸ '}${l.file} · H ${l.high_strength.toFixed(2)} · L ${l.low_strength.toFixed(2)}`
          : `${l.enabled ? '' : '⏸ '}${l.file} · ${l.strength.toFixed(2)}`));
    }
  }

  async function openLoraModal() {
    const { loras } = await api('/api/loras');
    const isVideo = model.kind === 'img2video';
    const loraDefaults = wanLoraDefaults(model);
    const body = h('div', {});
    const stackList = h('div', { class: 'list' });
    const libList = h('div', { class: 'list' });
    const wanStackNote = h('p', { class: 'muted' });

    function persistStack() {
      saveLoraStack(modelId, loraStack);
      renderLoraSummary();
    }

    function drawModal() {
      clear(stackList);
      if (isVideo) {
        wanStackNote.textContent = `Wan 2.2 I2V LoRAs only; compatibility is checked at generation · ${loraStack.length} / ${loraDefaults.maxStack} slots used`;
      }
      if (!loraStack.length) stackList.append(h('p', { class: 'muted' }, 'Nothing imported — add from the library below.'));
      for (const l of loraStack) {
        const check = h('input', { type: 'checkbox', checked: l.enabled, title: 'Active in generations' });
        check.onchange = () => { l.enabled = check.checked; persistStack(); };
        const remove = h('button', {
          class: 'icon-btn', 'aria-label': `Remove ${l.file} from stack`, onclick: () => {
            loraStack = loraStack.filter(x => x !== l);
            persistStack();
            drawModal();
          },
        }, '✕');
        let controls;
        if (isVideo) {
          const high = h('input', { type: 'range', min: 0, max: 2, step: 0.05, value: l.high_strength });
          const low = h('input', { type: 'range', min: 0, max: 2, step: 0.05, value: l.low_strength });
          const highValue = h('span', { class: 'mono' }, l.high_strength.toFixed(2));
          const lowValue = h('span', { class: 'mono' }, l.low_strength.toFixed(2));
          high.oninput = () => { l.high_strength = +high.value; highValue.textContent = l.high_strength.toFixed(2); persistStack(); };
          low.oninput = () => { l.low_strength = +low.value; lowValue.textContent = l.low_strength.toFixed(2); persistStack(); };
          controls = h('div', { class: 'wan-lora-controls' },
            h('label', {}, h('span', {}, 'High · motion'), high, highValue),
            h('label', {}, h('span', {}, 'Low · detail'), low, lowValue), remove);
        } else {
          const slider = h('input', { type: 'range', min: 0, max: 2, step: 0.05, value: Math.max(0, l.strength) });
          const valLabel = h('span', { class: 'mono', style: 'width:48px;text-align:right' }, l.strength.toFixed(2));
          slider.oninput = () => { l.strength = +slider.value; valLabel.textContent = l.strength.toFixed(2); persistStack(); };
          controls = h('div', { class: 'lora-stack-controls' },
            h('div', { class: 'lora-stack-slider' }, slider), valLabel, remove);
        }
        stackList.append(h('div', { class: 'list-row lora-stack-row' },
          check,
          h('div', { class: 'grow lora-stack-name' }, l.file),
          controls));
      }
      clear(libList);
      const available = loras.filter(lora => !loraStack.some(l => l.file === lora.file));
      if (!available.length) libList.append(h('p', { class: 'muted' },
        loras.length ? 'Everything from the library is already imported.' : 'No local LoRAs yet — download some from the LoRAs page.'));
      for (const lora of available) {
        const stackFull = isVideo && loraStack.length >= loraDefaults.maxStack;
        libList.append(h('div', { class: 'list-row' },
          h('div', { class: 'grow' },
            h('div', {}, lora.label || lora.file),
            h('div', { class: 'muted mono' }, `${lora.file} · ${fmtBytes(lora.size)}`)),
          h('button', {
            class: 'btn small ghost', disabled: stackFull,
            title: stackFull ? `Wan supports up to ${loraDefaults.maxStack} LoRAs` : null,
            onclick: () => {
              if (isVideo && loraStack.length >= loraDefaults.maxStack) return;
              loraStack.push({
                file: lora.file,
                strength: 1.0,
                high_strength: loraDefaults.highStrength,
                low_strength: loraDefaults.lowStrength,
                enabled: true,
              });
              persistStack();
              drawModal();
            },
          }, stackFull ? 'Stack full' : 'Add')));
      }
    }

    body.append(h('h3', {}, 'Stack'),
      h('p', { class: 'muted' }, isVideo
        ? 'High shapes motion and composition; Low shapes texture and detail. Checkbox pauses both without losing their strengths.'
        : 'Checkbox toggles a LoRA without losing its strength; ✕ removes it.'),
      isVideo ? wanStackNote : null,
      stackList,
      h('h3', { class: 'section-gap' }, 'Library'), libList);
    drawModal();
    modal('LoRA stack', body, { wide: true });
  }

  async function submit() {
    persist();
    const isVideo = model.kind === 'img2video';
    const enabledLoras = loraStack.filter(l => l.enabled);
    if (!prompt.value.trim()) { toast('Enter a prompt first', 'error'); return; }
    if (model.kind === 'edit' && !refFile) { toast('This model needs a reference image', 'error'); return; }
    if (isVideo && !refFile) { toast('Wan needs a start image', 'error'); return; }
    if (isVideo && enabledLoras.length > wanLoraDefaults(model).maxStack) {
      toast(`Wan supports at most ${wanLoraDefaults(model).maxStack} stacked LoRAs`, 'error');
      return;
    }

    let w = +width.value;
    let hgt = +height.value;
    if (!isVideo) {
      // Snap dimensions to the model's latent grid (e.g. 1080 -> 1072 for 16px).
      const mult = model.dim_multiple || 16;
      const snap = v => Math.max(64, Math.min(2048, Math.floor((2 * v + mult - 1) / (2 * mult)) * mult));
      [w, hgt] = [snap(w), snap(hgt)];
      if (w !== +width.value || hgt !== +height.value) {
        width.value = w; height.value = hgt;
        persist(); syncAspect();
        toast(`Resolution adjusted to ${w}×${hgt} (${model.name} needs multiples of ${mult})`);
      }
    }
    genBtn.disabled = true;
    try {
      const videoSize = wanOutputSize() || {
        width: model.defaults?.width || 832,
        height: model.defaults?.height || 480,
      };
      if (isVideo && (Math.min(videoSize.width, videoSize.height) < 64 || Math.max(videoSize.width, videoSize.height) > 2048)) {
        toast('Start image aspect ratio is too extreme for Wan video', 'error');
        return;
      }
      const body = isVideo ? {
        model_id: modelId,
        prompt: prompt.value,
        negative_prompt: '',
        steps: WAN_VIDEO.steps,
        cfg: WAN_VIDEO.cfg,
        width: videoSize.width,
        height: videoSize.height,
        seed: +seed.value,
        loras: enabledLoras.map(l => ({
          file: l.file,
          high_strength: l.high_strength,
          low_strength: l.low_strength,
        })),
        ref_image_b64: refFile.b64,
        video_tier: videoTier,
        video_aspect: videoAspect,
        num_frames: videoFrameCount(),
        fps: videoFps,
      } : {
        model_id: modelId,
        prompt: prompt.value,
        negative_prompt: negative.value,
        steps: +steps.value, cfg: +cfg.value,
        width: w, height: hgt,
        seed: +seed.value,
        loras: enabledLoras.map(l => ({ file: l.file, strength: l.strength })),
      };
      if (model.kind === 'edit' && refFile) body.ref_image_b64 = refFile.b64;
      if (isVideo) {
        if (resultObjectURL) URL.revokeObjectURL(resultObjectURL);
        resultObjectURL = null;
        showMedia(refFile.url, refFile.mime, videoSize.width, videoSize.height);
      }
      const res = await api('/api/generate', { method: 'POST', body });
      toast(res.position > 1 ? `Queued (position ${res.position})` : `${isVideo ? 'Video generation' : 'Generation'} started`);
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

  function setPreviewAspect(mediaWidth, mediaHeight) {
    if (mediaWidth > 0 && mediaHeight > 0) previewBox.style.aspectRatio = `${mediaWidth} / ${mediaHeight}`;
  }

  function showMedia(url, mime = 'image/png', mediaWidth = 0, mediaHeight = 0) {
    setPreviewAspect(mediaWidth, mediaHeight);
    const isVideo = mime.startsWith('video/');
    previewVideo.hidden = !isVideo;
    previewImg.hidden = isVideo;
    previewImg.onclick = null;
    previewImg.style.cursor = '';
    if (isVideo) {
      previewVideo.src = url;
      previewVideo.load();
    } else {
      previewVideo.pause();
      previewVideo.removeAttribute('src');
      previewVideo.load();
      previewImg.src = url;
    }
    previewEmpty.hidden = true;
  }

  async function refreshQueue() { renderQueue(await api('/api/queue')); }

  function renderQueue(q) {
    clear(queueList);
    if (modelKind(q.current?.model_id) === 'img2video') {
      setPreviewAspect(q.current.width, q.current.height);
    }
    const rows = [];
    if (q.current) rows.push([q.current, 'now']);
    for (const j of q.queued) rows.push([j, 'queued']);
    for (const j of q.history.slice(0, 12)) rows.push([j, 'past']);
    if (!rows.length) queueList.append(h('p', { class: 'muted' }, 'Nothing queued.'));
    for (const [j, kind] of rows) {
      if (j.status === 'done' && j.result_id && !j.asset_id) collectResult(j);
      const badgeClass = { done: 'ok', error: 'err', blocked: 'err', cancelled: 'warn', running: 'busy', starting: 'busy', queued: '' }[j.status] || '';
      let thumb = null;
      if (j.asset_id) {
        const mime = jobMime(j);
        const media = mime.startsWith('video/')
          ? h('video', { class: 'queue-thumb', muted: true, playsinline: true, preload: 'metadata', 'aria-label': 'Video result' })
          : h('img', { class: 'queue-thumb', alt: 'result' });
        decryptedAssetURL(j.asset_id, mime).then(url => {
          media.src = url;
          media.onclick = () => lightbox(url, { mime, metaEl: h('span', {}, j.prompt) });
        }).catch(() => media.remove());
        thumb = media;
      }
      const remove = kind === 'past'
        ? h('button', {
          class: 'icon-btn', 'aria-label': 'Remove from history', onclick: async () => {
            if (j.asset_id) {
              if (!await confirmModal('Remove generation',
                'This removes the entry AND deletes the saved asset from the library.')) return;
              await api(`/api/assets/${j.asset_id}`, { method: 'DELETE' }).catch(() => { });
              evictDecryptedAssetURL(j.asset_id);
            }
            api(`/api/jobs/${j.id}/history`, { method: 'DELETE' }).then(refreshQueue).catch(e => toast(e.message, 'error'));
          },
        }, '✕')
        : h('button', { class: 'icon-btn', 'aria-label': 'Cancel', onclick: () => api(`/api/jobs/${j.id}/cancel`, { method: 'POST' }).then(refreshQueue).catch(e => toast(e.message, 'error')) }, '✕');
      queueList.append(h('div', { class: 'queue-item' },
        thumb,
        h('span', { class: `badge ${badgeClass}` }, j.status),
        h('span', { class: 'qprompt', title: j.error || j.prompt }, `${modelName(j.model_id)} — ${j.prompt}`),
        j.error ? h('span', { class: 'muted', title: j.error }, '⚠') : null,
        remove));
    }
  }

  function modelName(id) { return (models.find(m => m.id === id) || { name: id }).name; }
  function modelKind(id) { return (models.find(m => m.id === id) || {}).kind; }
  function jobMime(job) {
    return job.mime || job.output_mime || (modelKind(job.model_id) === 'img2video' ? 'video/mp4' : 'image/png');
  }

  async function collectResult(job) {
    // The attach-asset call republishes the job's "done" event; don't try to
    // collect the same (already-consumed) outbox result twice.
    if (collectingResults.has(job.result_id)) return;
    collectingResults.add(job.result_id);
    try {
      const resp = await apiBlob(`/api/results/${job.result_id}`);
      const metaB64 = resp.headers.get('x-pleo-meta-plain');
      const meta = metaB64 ? JSON.parse(atob(metaB64)) : {};
      const contentType = (resp.headers.get('content-type') || '').split(';')[0];
      const mime = contentType && contentType !== 'application/octet-stream' ? contentType : jobMime(job);
      const bytes = await resp.arrayBuffer();
      if (!disposed) {
        if (resultObjectURL) URL.revokeObjectURL(resultObjectURL);
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        resultObjectURL = url;
        showMedia(url, mime, meta.width || job.width, meta.height || job.height);
        if (mime.startsWith('video/')) {
          previewVideo.onclick = null;
          previewImg.onclick = null;
        } else {
          previewImg.onclick = () => lightbox(url, { mime, metaEl: h('span', {}, metaLine(meta)) });
          previewImg.style.cursor = 'zoom-in';
        }
      }
      // Encrypt in the browser, upload ciphertext, then discard the server copy.
      const encMeta = await encryptJSON({ ...meta, mime, saved: Date.now() });
      const encBlob = await encryptBytes(bytes);
      const entry = await api('/api/assets', { method: 'POST', body: encBlob, headers: {
        'X-Pleo-Kind': 'generated', 'X-Pleo-Meta': encMeta, 'X-Pleo-Mime': mime,
      } });
      await api(`/api/results/${job.result_id}`, { method: 'DELETE' });
      await api(`/api/jobs/${job.id}/asset`, { method: 'POST', body: { asset_id: entry.id } }).catch(() => { });
      if (!disposed) {
        toast('Saved to assets (encrypted)', 'success');
        refreshQueue();
      }
    } catch (e) {
      if (!disposed) toast(`Result save failed: ${e.message}`, 'error');
    } finally {
      collectingResults.delete(job.result_id);
    }
  }

  function metaLine(meta) {
    return [meta.prompt, meta.seed != null ? `seed ${meta.seed}` : null,
      meta.steps != null ? `${meta.steps} steps` : null,
      meta.cfg != null ? `cfg ${meta.cfg}` : null,
      meta.width && meta.height ? `${meta.width}×${meta.height}` : null,
      meta.num_frames ? `${meta.num_frames} frames` : null,
      meta.fps ? `${meta.fps} fps` : null].filter(Boolean).join(' · ');
  }

  // ---------- live events ----------
  const off = onEvent((ev) => {
    if (ev.type === 'runner') {
      clear(badgeHost).append(runnerBadge(ev, models));
      return;
    }
    if (ev.type === 'step') {
      liveJobId = ev.job_id;
      if (ev.preview_b64) showMedia(`data:image/png;base64,${ev.preview_b64}`);
      const pct = ev.total ? Math.round(ev.step / ev.total * 100) : 0;
      const rawStage = ev.stage || ev.phase;
      const stage = {
        prepare: 'Preparing image and prompt', high_noise: 'High-noise expert · motion and composition',
        switch: 'Switching experts', low_noise: 'Low-noise expert · detail and refinement',
        decode: 'Decoding video', encode: 'Encoding MP4',
      }[rawStage] || rawStage;
      setStatus(stage || `Step ${ev.step} / ${ev.total}`, { cancellable: true, progress: pct });
    } else if (ev.type === 'job') {
      const j = ev.job;
      if (modelKind(j.model_id) === 'img2video' && j.status !== 'queued' && j.width > 0 && j.height > 0) {
        setPreviewAspect(j.width, j.height);
      }
      if (j.status === 'queued') refreshQueue();
      if (j.status === 'starting') { liveJobId = j.id; setStatus(`Starting ${modelName(j.model_id)}…`, { cancellable: true, progress: 0 }); refreshQueue(); }
      if (j.status === 'running') { liveJobId = j.id; setStatus('Generating…', { cancellable: true, progress: 0 }); refreshQueue(); }
      if (['done', 'error', 'cancelled', 'blocked'].includes(j.status)) {
        liveJobId = null;
        setStatus(j.status === 'done' ? 'Done' : `${j.status}${j.error ? `: ${j.error}` : ''}`);
        if (j.status === 'done' && j.result_id && !j.asset_id) collectResult(j);
        if (j.status === 'blocked') toast(j.error || 'Blocked by moderation', 'error');
        if (j.status === 'error') toast(j.error || 'Generation failed', 'error');
        refreshQueue();
      }
    }
  });
  return () => {
    disposed = true;
    off();
    previewVideo.pause();
    previewVideo.removeAttribute('src');
    previewVideo.load();
    if (resultObjectURL) URL.revokeObjectURL(resultObjectURL);
    if (refFile?.ownedURL && refFile.url) URL.revokeObjectURL(refFile.url);
  };
}

function runnerBadge(runner, models) {
  if (!runner || runner.status === 'stopped') return h('span', { class: 'badge' }, 'runner stopped');
  const model = models.find(m => m.id === runner.model_id);
  const name = model ? model.name : (runner.model_id || 'runner');
  const cls = runner.status === 'busy' ? 'busy' : runner.status === 'ready' ? 'ok' : 'warn';
  return h('span', { class: `badge ${cls}` }, `${name} · ${runner.status}`);
}

function wanLoraDefaults(model) {
  const defaults = model?.lora_defaults || {};
  return {
    highStrength: Number(defaults.high_strength ?? 0.7),
    lowStrength: Number(defaults.low_strength ?? 0.5),
    maxStack: Math.max(1, Math.floor(Number(defaults.max_stack ?? 4))),
  };
}

function normalizeStack(stack, defaults = {}) {
  return (stack || []).map(l => ({
    enabled: true,
    strength: 1.0,
    high_strength: Number(defaults.high_strength ?? 0.7),
    low_strength: Number(defaults.low_strength ?? 0.5),
    ...l,
  }));
}

function imageDimensions(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Unsupported or damaged image'));
    img.src = url;
  });
}

function sourceMime(file) {
  if (SOURCE_MIMES.has(file.type)) return file.type;
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[
    String(file.name || '').split('.').pop().toLowerCase()
  ] || '';
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
