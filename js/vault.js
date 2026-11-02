// Adding, listing, reading and deleting files in the encrypted store.

import { CHUNK_SIZE, seal, open, sealJSON, openJSON, aad, randomId } from './crypto.js';
import * as db from './db.js';

const EXT_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', log: 'text/plain',
  xml: 'text/xml', html: 'text/html', rtf: 'application/rtf',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pages: 'application/vnd.apple.pages', numbers: 'application/vnd.apple.numbers', key: 'application/vnd.apple.keynote',
  zip: 'application/zip',
};

const TEXT_TYPES = new Set(['application/json', 'text/xml', 'application/xml']);

export const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();

export function typeOf(file) {
  return file.type || EXT_TYPES[extOf(file.name)] || 'application/octet-stream';
}

export function kindOf(type) {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('text/') || TEXT_TYPES.has(type)) return 'text';
  return 'other';
}

/**
 * Encrypt and store one file. The file is read 4 MB at a time, so even large
 * videos never need to sit in memory all at once.
 */
export async function addFile(key, file, { thumb, onProgress } = {}) {
  const id = randomId();
  const type = typeOf(file);
  const chunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

  for (let i = 0; i < chunks; i++) {
    const buf = await file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer();
    const value = await seal(key, buf, aad.chunk(id, i));
    await db.putMany([{ store: 'chunks', key: [id, i], value }]);
    onProgress?.(Math.min(file.size, (i + 1) * CHUNK_SIZE));
  }

  const meta = {
    name: file.name || `file-${id.slice(0, 6)}`,
    type,
    kind: kindOf(type),
    size: file.size,
    chunks,
    added: Date.now(),
    modified: file.lastModified || Date.now(),
    hasThumb: !!thumb,
  };

  // The item record goes in last, so an interrupted import never leaves a
  // visible item with missing pieces.
  const ops = [];
  if (thumb) ops.push({ store: 'thumbs', key: id, value: await seal(key, await thumb.arrayBuffer(), aad.thumb(id)) });
  ops.push({ store: 'items', value: { id, meta: await sealJSON(key, meta, aad.meta(id)) } });
  await db.putMany(ops);
  return { id, ...meta };
}

/** Decrypt the metadata of every item, newest first. */
export async function listItems(key) {
  const rows = await db.getAll('items');
  const items = await Promise.all(rows.map(async (r) => {
    try {
      return { id: r.id, ...(await openJSON(key, r.meta, aad.meta(r.id))) };
    } catch {
      return null; // corrupt record: skip rather than break the whole list
    }
  }));
  return items.filter(Boolean).sort((a, b) => b.added - a.added);
}

export async function readThumb(key, id) {
  const blob = await db.get('thumbs', id);
  return blob ? new Blob([await open(key, blob, aad.thumb(id))], { type: 'image/jpeg' }) : null;
}

/** Decrypt a whole file back into a Blob (held in memory until released). */
export async function readFile(key, item, onProgress) {
  const parts = [];
  for (let i = 0; i < item.chunks; i++) {
    const blob = await db.get('chunks', [item.id, i]);
    if (!blob) throw new Error(`Missing piece ${i + 1} of ${item.chunks}`);
    parts.push(new Blob([await open(key, blob, aad.chunk(item.id, i))]));
    onProgress?.((i + 1) / item.chunks);
  }
  return new Blob(parts, { type: item.type });
}

export const removeItem = (id) => db.deleteItem(id);
