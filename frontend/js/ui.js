// Tiny DOM helpers, toasts, modal, lightbox.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function toast(message, kind = 'info', ms = 3500) {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  const t = h('div', { class: `toast toast-${kind}` }, message);
  host.append(t);
  setTimeout(() => { t.classList.add('gone'); setTimeout(() => t.remove(), 300); }, ms);
}

export function modal(title, content, { wide = false } = {}) {
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const box = h('div', { class: `modal${wide ? ' modal-wide' : ''}` },
    h('div', { class: 'modal-head' },
      h('h3', {}, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, '✕')),
    h('div', { class: 'modal-body' }, content));
  overlay.append(box);
  document.body.append(overlay);
  function close() { overlay.remove(); }
  return { close, overlay };
}

export function confirmModal(title, message, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    const body = h('div', {},
      h('p', { class: 'muted' }, message),
      h('div', { class: 'row gap end', style: 'margin-top:16px' },
        h('button', { class: 'btn ghost', onclick: () => { m.close(); resolve(false); } }, 'Cancel'),
        h('button', { class: 'btn danger', onclick: () => { m.close(); resolve(true); } }, confirmLabel)));
    const m = modal(title, body);
  });
}

// Fullscreen lightbox. The close button sits OUTSIDE the image corner and the
// frame sizes itself to the image's native aspect ratio (no cropping).
export function lightbox(src, { metaEl = null, onDelete = null } = {}) {
  const img = h('img', { src, alt: 'asset' });
  const frame = h('div', { class: 'lightbox-frame' },
    h('button', { class: 'lightbox-close', 'aria-label': 'Close', onclick: () => close() }, '✕'),
    // Delete sits OUTSIDE the image, top-left (mirror of the close button),
    // so long metadata under tall images can never push it off-screen.
    onDelete ? h('button', {
      class: 'lightbox-delete', 'aria-label': 'Delete asset',
      onclick: async () => { if (await onDelete()) close(); },
    }, 'Delete') : null,
    img,
    metaEl ? h('div', { class: 'lightbox-meta' }, metaEl) : null);
  const overlay = h('div', {
    class: 'overlay lightbox-overlay',
    onclick: (e) => { if (e.target === overlay) close(); },
  }, frame);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  return { close };
}

export function spinner(label = 'Loading…') {
  return h('div', { class: 'spinner-wrap' }, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, label));
}
