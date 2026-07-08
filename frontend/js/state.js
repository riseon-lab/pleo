// Browser-side persistence of UI state (params, LoRA stacks, sidebar) in
// localStorage. Nothing here is secret; secrets stay in the crypto layer.

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full */ }
}

export function getParams(modelId, defaults) {
  return { ...defaults, ...read(`pleo-params:${modelId}`, {}) };
}
export function saveParams(modelId, params) { write(`pleo-params:${modelId}`, params); }

export function getLoraStack(modelId) { return read(`pleo-loras:${modelId}`, []); }
export function saveLoraStack(modelId, stack) { write(`pleo-loras:${modelId}`, stack); }

export function getUI() { return read('pleo-ui', {}); }
export function saveUI(patch) { write('pleo-ui', { ...getUI(), ...patch }); }
