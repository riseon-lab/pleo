// Crypto facade: talks to the worker, keeps the active (non-extractable)
// encryption key, and persists it in IndexedDB across refreshes. The raw key
// material is never readable by page JS and never stored anywhere readable.

const worker = new Worker('js/crypto-worker.js');
let seq = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const { id, ok, result, error } = e.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  ok ? p.resolve(result) : p.reject(new Error(error));
};

function call(msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...msg }, transfer);
  });
}

let encKey = null; // CryptoKey (non-extractable)

export function hasKey() { return encKey !== null; }

export async function deriveAndActivate(password, saltB64, iterations) {
  const { encKey: k, authKeyB64 } = await call({ op: 'derive', password, salt: saltB64, iterations });
  encKey = k;
  await idbPut('encKey', k);
  return authKeyB64;
}

export async function loadStoredKey() {
  encKey = await idbGet('encKey');
  return encKey !== null;
}

export async function clearKey() {
  encKey = null;
  await idbDelete('encKey');
}

function needKey() {
  if (!encKey) throw new Error('No encryption key — please log in again');
  return encKey;
}

export async function encryptBytes(arrayBuffer) {
  return call({ op: 'encrypt', key: needKey(), data: arrayBuffer }, [arrayBuffer]);
}

export async function decryptBytes(arrayBuffer) {
  return call({ op: 'decrypt', key: needKey(), data: arrayBuffer }, [arrayBuffer]);
}

export async function encryptJSON(obj) {
  const buf = new TextEncoder().encode(JSON.stringify(obj)).buffer;
  return bufToB64(await encryptBytes(buf));
}

export async function decryptJSON(b64) {
  const plain = await decryptBytes(b64ToBuf(b64));
  return JSON.parse(new TextDecoder().decode(plain));
}

export function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function randomSaltB64() {
  return bufToB64(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

// ---- IndexedDB (stores the non-extractable CryptoKey object) ----

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pleo', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(name, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put(value, name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('keys').objectStore('keys').get(name);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
