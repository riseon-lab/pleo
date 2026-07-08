// Web Worker: key derivation and AES-GCM encrypt/decrypt off the main thread.
// The password only ever exists here transiently during derivation. The
// encryption key is returned as a NON-EXTRACTABLE CryptoKey.

const ENC_INFO = new TextEncoder().encode('pleo-enc-v1');
const AUTH_INFO = new TextEncoder().encode('pleo-auth-v1');
const VERSION = 1;

async function derive(password, saltB64, iterations) {
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const passKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, passKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const encKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(16), info: ENC_INFO },
    hkdfKey, { name: 'AES-GCM', length: 256 }, false /* non-extractable */,
    ['encrypt', 'decrypt']);
  const authBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(16), info: AUTH_INFO }, hkdfKey, 256);
  const authKeyB64 = btoa(String.fromCharCode(...new Uint8Array(authBits)));
  return { encKey, authKeyB64 };
}

async function encrypt(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(ct, 13);
  return out.buffer;
}

async function decrypt(key, data) {
  const buf = new Uint8Array(data);
  if (buf[0] !== VERSION) throw new Error('Unknown blob version');
  const iv = buf.slice(1, 13);
  const ct = buf.slice(13);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
}

self.onmessage = async (e) => {
  const { id, op } = e.data;
  try {
    let result, transfer = [];
    if (op === 'derive') {
      result = await derive(e.data.password, e.data.salt, e.data.iterations);
    } else if (op === 'encrypt') {
      result = await encrypt(e.data.key, e.data.data);
      transfer = [result];
    } else if (op === 'decrypt') {
      result = await decrypt(e.data.key, e.data.data);
      transfer = [result];
    } else {
      throw new Error('unknown op');
    }
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
