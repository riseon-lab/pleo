// API client + SSE event bus.

export function getToken() { return sessionStorage.getItem('pleo-token'); }
export function setToken(t) { t ? sessionStorage.setItem('pleo-token', t) : sessionStorage.removeItem('pleo-token'); }

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export class ApiError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

async function handle(resp) {
  if (resp.status === 401) { onUnauthorized(); throw new ApiError(401, 'Not authenticated'); }
  if (!resp.ok) {
    let detail = resp.statusText;
    try { detail = (await resp.json()).detail || detail; } catch { /* not json */ }
    throw new ApiError(resp.status, detail);
  }
  return resp;
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  const token = getToken();
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) {
    if (body instanceof ArrayBuffer || body instanceof Uint8Array || body instanceof Blob) {
      opts.body = body;
      opts.headers['Content-Type'] = 'application/octet-stream';
    } else {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
  }
  const resp = await handle(await fetch(path, opts));
  const ct = resp.headers.get('content-type') || '';
  return ct.includes('json') ? resp.json() : resp;
}

export async function apiBlob(path) {
  const resp = await handle(await fetch(path, {
    headers: { Authorization: `Bearer ${getToken()}` },
  }));
  return resp;
}

// ---- SSE bus ----

const listeners = new Set();
let source = null;

export function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function connectEvents() {
  if (source) source.close();
  const token = getToken();
  if (!token) return;
  source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  source.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    for (const fn of listeners) { try { fn(ev); } catch (err) { console.error(err); } }
  };
  source.onerror = () => { /* EventSource auto-reconnects */ };
}

export function disconnectEvents() {
  if (source) { source.close(); source = null; }
}
