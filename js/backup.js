// Encrypted backup files (.pvault).
//
// A backup is a straight copy of the already-encrypted records plus the wrapped master
// key, so it is protected by the same passphrase the vault had when it was exported.
// Nothing is decrypted to make a backup.
//
// Layout (all integers little-endian):
//   "PVAULT01"                      8-byte magic
//   u32 headerLength, header JSON   { format, v, created, items, keyInfo (base64 fields) }
//   records, each:
//     u8 type (1 item, 2 thumb, 3 chunk), u8 idLength, id (ASCII),
//     [u32 chunkIndex  -- type 3 only], u32 payloadLength, payload
//   u8 0                            end marker (a missing marker means the file is truncated)
//
// Per item, chunks come first, then the thumbnail, then the item record, so a restore that
// is interrupted never leaves a visible item with missing pieces.

import { unlockKey, seal, open, aad, toB64, fromB64 } from './crypto.js';
import * as db from './db.js';

const MAGIC = 'PVAULT01';
const T_END = 0, T_ITEM = 1, T_THUMB = 2, T_CHUNK = 3;
const te = new TextEncoder();
const td = new TextDecoder();

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function recordHead(type, id, index, length) {
  const idBytes = te.encode(id);
  return [Uint8Array.of(type, idBytes.length), idBytes, ...(type === T_CHUNK ? [u32(index)] : []), u32(length)];
}

const encodeKeyInfo = (k) => ({ ...k, salt: toB64(k.salt), iv: toB64(k.iv), wrapped: toB64(k.wrapped) });
const decodeKeyInfo = (k) => ({ ...k, salt: fromB64(k.salt), iv: fromB64(k.iv), wrapped: fromB64(k.wrapped) });

/** Assemble the backup as a Blob. Blob parts reference stored data rather than copying it. */
export async function buildBackup(keyInfo, onProgress) {
  const items = await db.getAll('items');
  const thumbIds = new Set(await db.getAllKeys('thumbs'));
  const chunksById = new Map();
  for (const [id, i] of await db.getAllKeys('chunks')) {
    if (!chunksById.has(id)) chunksById.set(id, []);
    chunksById.get(id).push(i);
  }

  const header = te.encode(JSON.stringify({
    format: 'pvault', v: 1, created: new Date().toISOString(), items: items.length,
    keyInfo: encodeKeyInfo(keyInfo),
  }));
  const parts = [te.encode(MAGIC), u32(header.length), header];

  let n = 0;
  for (const item of items) {
    for (const i of chunksById.get(item.id) || []) {
      const blob = await db.get('chunks', [item.id, i]);
      parts.push(...recordHead(T_CHUNK, item.id, i, blob.size), blob);
    }
    if (thumbIds.has(item.id)) {
      const blob = await db.get('thumbs', item.id);
      parts.push(...recordHead(T_THUMB, item.id, 0, blob.size), blob);
    }
    parts.push(...recordHead(T_ITEM, item.id, 0, item.meta.size), item.meta);
    onProgress?.(++n / items.length);
  }
  parts.push(Uint8Array.of(T_END));
  return { blob: new Blob(parts, { type: 'application/octet-stream' }), count: items.length };
}

class Reader {
  constructor(file) { this.file = file; this.pos = 0; }
  check(n) { if (this.pos + n > this.file.size) throw new Error('This backup file is incomplete or damaged.'); }
  async bytes(n) {
    this.check(n);
    const b = new Uint8Array(await this.file.slice(this.pos, this.pos + n).arrayBuffer());
    this.pos += n;
    return b;
  }
  async u8() { return (await this.bytes(1))[0]; }
  async u32() { return new DataView((await this.bytes(4)).buffer).getUint32(0, true); }
  blob(n) { this.check(n); const b = this.file.slice(this.pos, this.pos + n); this.pos += n; return b; }
}

/** Read and validate a backup's header without needing the passphrase. */
export async function readBackupHeader(file) {
  const r = new Reader(file);
  if (file.size < 13 || td.decode(await r.bytes(8)) !== MAGIC) throw new Error('That is not a Vault backup file.');
  const header = JSON.parse(td.decode(await r.bytes(await r.u32())));
  if (header.format !== 'pvault' || header.v !== 1) throw new Error('Unsupported backup version.');
  return { header, keyInfo: decodeKeyInfo(header.keyInfo), reader: r };
}

/**
 * Restore or merge a backup.
 *  - Empty vault (currentKeyInfo null): the backup's key becomes the vault's key.
 *  - Existing vault: items are merged in. If the backup came from a different vault
 *    (different master key) each record is decrypted and re-encrypted with this vault's key.
 * Items whose id already exists are skipped, so importing the same backup twice is harmless.
 */
export async function importBackup(file, { passphrase, currentKey, currentKeyInfo, onProgress }) {
  const { keyInfo: backupKeyInfo, reader: r } = await readBackupHeader(file);
  const backupKey = await unlockKey(backupKeyInfo, passphrase); // throws WrongPassphrase

  let key = currentKey;
  let keyInfo = currentKeyInfo;
  if (!currentKeyInfo) {
    await db.set('meta', 'keyInfo', backupKeyInfo);
    key = backupKey;
    keyInfo = backupKeyInfo;
  }
  const reencrypt = keyInfo.kid !== backupKeyInfo.kid;
  const existing = new Set(await db.getAllKeys('items'));

  let added = 0, skipped = 0;
  let ops = [], opBytes = 0;
  const flush = async () => { await db.putMany(ops); ops = []; opBytes = 0; };

  for (;;) {
    const type = await r.u8();
    if (type === T_END) break;
    if (type !== T_ITEM && type !== T_THUMB && type !== T_CHUNK) throw new Error('This backup file is damaged.');
    const id = td.decode(await r.bytes(await r.u8()));
    const index = type === T_CHUNK ? await r.u32() : 0;
    let payload = r.blob(await r.u32());

    if (existing.has(id)) {
      if (type === T_ITEM) skipped++;
      continue;
    }
    const label = type === T_ITEM ? aad.meta(id) : type === T_THUMB ? aad.thumb(id) : aad.chunk(id, index);
    if (reencrypt) payload = await seal(key, await open(backupKey, payload, label), label);

    if (type === T_ITEM) { ops.push({ store: 'items', value: { id, meta: payload } }); added++; }
    else if (type === T_THUMB) ops.push({ store: 'thumbs', key: id, value: payload });
    else ops.push({ store: 'chunks', key: [id, index], value: payload });

    opBytes += payload.size;
    if (type === T_ITEM || opBytes > 32 * 1024 * 1024) await flush();
    onProgress?.(r.pos / file.size);
  }
  await flush();
  return { key, keyInfo, added, skipped };
}
