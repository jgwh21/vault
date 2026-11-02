// All encryption happens here, using the browser's built-in Web Crypto API.
//
// Key design:
//   passphrase --PBKDF2-SHA256 (600k rounds)--> key-encryption key (KEK)
//   KEK --AES-256-GCM--> wraps a random 256-bit master key
//   master key --AES-256-GCM--> encrypts every file chunk, thumbnail and metadata record
//
// Changing the passphrase only re-wraps the master key; files are never re-encrypted.
// Every ciphertext is bound to its purpose with additional authenticated data (AAD),
// so records can't be swapped or reordered without detection.

const te = new TextEncoder();
const td = new TextDecoder();

export const PBKDF2_ITER = 600_000;
export const CHUNK_SIZE = 4 * 1024 * 1024;
const KEY_AAD = te.encode('vault-master-key-v1');

export class WrongPassphrase extends Error {
  constructor() { super('Wrong passphrase'); this.name = 'WrongPassphrase'; }
}

export const random = (n) => crypto.getRandomValues(new Uint8Array(n));

export function randomId() {
  return Array.from(random(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveKek(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey(
    'raw', te.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function importMaster(raw) {
  // Non-extractable: once imported, script can use the key but never read it back.
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function wrap(raw, passphrase, kid) {
  const salt = random(16);
  const iv = random(12);
  const kek = await deriveKek(passphrase, salt, PBKDF2_ITER);
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: KEY_AAD }, kek, raw);
  return { v: 1, kid, salt, iter: PBKDF2_ITER, iv, wrapped: new Uint8Array(wrapped) };
}

async function unwrapRaw(keyInfo, passphrase) {
  const kek = await deriveKek(passphrase, keyInfo.salt, keyInfo.iter);
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: keyInfo.iv, additionalData: KEY_AAD }, kek, keyInfo.wrapped));
  } catch {
    throw new WrongPassphrase();
  }
}

/** Create a brand-new master key protected by `passphrase`. */
export async function createKey(passphrase) {
  const raw = random(32);
  const keyInfo = await wrap(raw, passphrase, randomId());
  const key = await importMaster(raw);
  raw.fill(0);
  return { keyInfo, key };
}

/** Unlock a stored master key. Throws WrongPassphrase on failure. */
export async function unlockKey(keyInfo, passphrase) {
  const raw = await unwrapRaw(keyInfo, passphrase);
  const key = await importMaster(raw);
  raw.fill(0);
  return key;
}

/** Same master key (same kid), new passphrase. */
export async function rewrapKey(keyInfo, oldPassphrase, newPassphrase) {
  const raw = await unwrapRaw(keyInfo, oldPassphrase);
  const next = await wrap(raw, newPassphrase, keyInfo.kid);
  raw.fill(0);
  return next;
}

/** Encrypt bytes into a Blob laid out as [12-byte IV][ciphertext + 16-byte tag]. */
export async function seal(key, data, aad) {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, data);
  return new Blob([iv, ct]);
}

/** Decrypt a Blob produced by seal(). Throws if tampered with or the AAD doesn't match. */
export async function open(key, blob, aad) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf.subarray(0, 12), additionalData: te.encode(aad) }, key, buf.subarray(12));
}

export const sealJSON = (key, obj, aad) => seal(key, te.encode(JSON.stringify(obj)), aad);
export const openJSON = async (key, blob, aad) => JSON.parse(td.decode(await open(key, blob, aad)));

// AAD labels, shared by the vault and backup code so they always agree.
export const aad = {
  meta: (id) => `meta:${id}`,
  thumb: (id) => `thumb:${id}`,
  chunk: (id, i) => `chunk:${id}:${i}`,
  folders: () => 'folders',
};

export function toB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}
