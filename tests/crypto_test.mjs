// Mirrors frontend/js/crypto-worker.js logic 1:1 using WebCrypto in Node,
// verifying derivation + AES-GCM blob roundtrip and cross-checking the
// auth-key against an independent Python implementation.
import { webcrypto as crypto } from 'node:crypto';

const ENC_INFO = new TextEncoder().encode('pleo-enc-v1');
const AUTH_INFO = new TextEncoder().encode('pleo-auth-v1');

async function derive(password, saltB64, iterations) {
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const passKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, passKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const encKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(16), info: ENC_INFO },
    hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const authBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(16), info: AUTH_INFO }, hkdfKey, 256);
  return { encKey, authKeyB64: Buffer.from(authBits).toString('base64') };
}

async function encrypt(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = 1; out.set(iv, 1); out.set(ct, 13);
  return out;
}

async function decrypt(key, buf) {
  if (buf[0] !== 1) throw new Error('bad version');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(1, 13) }, key, buf.slice(13)));
}

const password = 'correct horse battery staple';
const saltB64 = 'AAECAwQFBgcICQoLDA0ODw=='; // fixed vector 00..0f
const iterations = 600000;

const { encKey, authKeyB64 } = await derive(password, saltB64, iterations);
console.log('authKeyB64:', authKeyB64);

// roundtrip
const plain = crypto.getRandomValues(new Uint8Array(60000));
const blob = await encrypt(encKey, plain.slice().buffer);
const back = await decrypt(encKey, blob);
const same = Buffer.compare(Buffer.from(plain), Buffer.from(back)) === 0;
console.log('roundtrip byte-exact:', same);
console.log('blob overhead bytes:', blob.length - plain.length, '(expect 29 = 1 ver + 12 iv + 16 tag)');

// tamper detection
const tampered = blob.slice(); tampered[40] ^= 0xff;
let rejected = false;
try { await decrypt(encKey, tampered); } catch { rejected = true; }
console.log('tampered ciphertext rejected:', rejected);

// wrong password yields different auth key (and can't decrypt)
const other = await derive('wrong password', saltB64, iterations);
console.log('wrong password -> different authKey:', other.authKeyB64 !== authKeyB64);
let wrongRejected = false;
try { await decrypt(other.encKey, blob); } catch { wrongRejected = true; }
console.log('wrong key cannot decrypt:', wrongRejected);

if (!same || !rejected || !wrongRejected) process.exit(1);
