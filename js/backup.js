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
//     u8 type (1 item, 2 thumb, 3 chunk, 4 folder list), u8 idLength, id (ASCII; empty for 4),
//     [u32 chunkIndex  -- type 3 only], u32 payloadLength, payload
//   u8 0                            end marker (a missing marker means the file is truncated)
//
// The folder list (version 2+) comes first. Per item, chunks come first, then the thumbnail,
// then the item record, so a restore that is interrupted never leaves a visible item with
// missing pieces.
//
// Large backups are split into parts of about PART_BYTES. Each part is a complete file in the
// format above (header with part/parts/set added), holding the next run of records; a big video
// may continue into the next part, its item record coming in the part with its last chunk.
// Parts are built one at a time because iPhones give a web app too little memory to hold a whole
// vault: holding a 3 GB backup in one go crashes the page.

import { CHUNK_SIZE, unlockKey, seal, open, openJSON, aad, toB64, fromB64, randomId } from './crypto.js';
import * as db from './db.js';
import { loadFolders, saveFolders } from './vault.js';

const MAGIC = 'PVAULT01';
const VERSION = 2; // v2 added the folder list; v1 backups still import
const T_END = 0, T_ITEM = 1, T_THUMB = 2, T_CHUNK = 3, T_FOLDERS = 4;
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

export const PART_BYTES = 200 * 1024 * 1024;
const SEAL_OVERHEAD = 28; // 12-byte IV + 16-byte GCM tag per encrypted record

/**
 * Decide which records go in which part, from the decrypted item list (sizes are known there),
 * without reading any stored data. Returns { parts: [[record, …], …], bytes: [estimate, …] }.
 */
export function planBackup(items, partBytes = PART_BYTES) {
  const parts = [[]];
  const bytes = [0];
  const add = (record, size) => {
    if (bytes.at(-1) + size > partBytes && parts.at(-1).length) { parts.push([]); bytes.push(0); }
    parts.at(-1).push(record);
    bytes[bytes.length - 1] += size;
  };
  for (const it of items) {
    for (let i = 0; i < it.chunks; i++) {
      add({ type: T_CHUNK, id: it.id, index: i }, Math.max(0, Math.min(CHUNK_SIZE, it.size - i * CHUNK_SIZE)) + SEAL_OVERHEAD);
    }
    if (it.hasThumb) add({ type: T_THUMB, id: it.id }, 40_000);
    add({ type: T_ITEM, id: it.id }, 1_000);
  }
  return { parts, bytes, set: randomId() };
}

/** Assemble part k of a plan as a Blob, reading only that part's records. */
export async function buildPart(keyInfo, plan, k, onProgress) {
  const records = plan.parts[k];
  const header = te.encode(JSON.stringify({
    format: 'pvault', v: VERSION, created: new Date().toISOString(),
    items: records.filter((r) => r.type === T_ITEM).length,
    part: k + 1, parts: plan.parts.length, set: plan.set,
    keyInfo: encodeKeyInfo(keyInfo),
  }));
  const out = [te.encode(MAGIC), u32(header.length), header];

  const folders = await db.get('meta', 'folders'); // in every part, so any part restores its folders
  if (folders) out.push(...recordHead(T_FOLDERS, '', 0, folders.size), folders);

  for (const [n, rec] of records.entries()) {
    const blob = rec.type === T_CHUNK ? await db.get('chunks', [rec.id, rec.index])
      : rec.type === T_THUMB ? await db.get('thumbs', rec.id)
        : (await db.get('items', rec.id))?.meta;
    if (!blob) throw new Error(`Part of an item is missing from storage (${rec.id.slice(0, 8)}).`);
    out.push(...recordHead(rec.type, rec.id, rec.index || 0, blob.size), blob);
    onProgress?.((n + 1) / records.length);
  }
  out.push(Uint8Array.of(T_END));
  return new Blob(out, { type: 'application/octet-stream' });
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
  if (header.format !== 'pvault' || !(header.v >= 1 && header.v <= VERSION)) {
    throw new Error('This backup was made by a newer version of Vault. Update the app and try again.');
  }
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
    if (type < T_ITEM || type > T_FOLDERS) throw new Error('This backup file is damaged.');
    const id = td.decode(await r.bytes(await r.u8()));
    const index = type === T_CHUNK ? await r.u32() : 0;
    let payload = r.blob(await r.u32());

    if (type === T_FOLDERS) {
      // Merge folder lists: add folders this vault doesn't have; existing ones keep their local name.
      const incoming = await openJSON(backupKey, payload, aad.folders());
      const folders = await loadFolders(key);
      const have = new Set(folders.map((f) => f.id));
      await saveFolders(key, [...folders, ...incoming.filter((f) => !have.has(f.id))]);
      continue;
    }

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
