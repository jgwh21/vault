// Thin promise wrapper around IndexedDB. Everything stored here is already encrypted,
// apart from the random item ids and the wrapped (passphrase-protected) key record.
//
// Stores:
//   meta    key/value settings: 'keyInfo', 'lastBackup'
//   items   { id, meta: Blob }   encrypted file metadata (name, type, size, dates...)
//   thumbs  id -> Blob           encrypted thumbnail
//   chunks  [id, index] -> Blob  encrypted 4 MB pieces of the file

const DB_NAME = 'vault';
let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('meta');
      d.createObjectStore('items', { keyPath: 'id' });
      d.createObjectStore('thumbs');
      d.createObjectStore('chunks');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const committed = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted (device may be out of space)'));
});

export async function get(store, key) {
  return done((await db()).transaction(store).objectStore(store).get(key));
}

export async function getAll(store) {
  return done((await db()).transaction(store).objectStore(store).getAll());
}

export async function getAllKeys(store) {
  return done((await db()).transaction(store).objectStore(store).getAllKeys());
}

export async function set(store, key, value) {
  const tx = (await db()).transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  s.keyPath ? s.put(value) : s.put(value, key);
  return committed(tx);
}

/** Write many records in one transaction. ops: [{ store, key?, value }] */
export async function putMany(ops) {
  if (!ops.length) return;
  const stores = [...new Set(ops.map((o) => o.store))];
  const tx = (await db()).transaction(stores, 'readwrite');
  for (const { store, key, value } of ops) {
    const s = tx.objectStore(store);
    s.keyPath ? s.put(value) : s.put(value, key);
  }
  return committed(tx);
}

export async function deleteItem(id) {
  const tx = (await db()).transaction(['items', 'thumbs', 'chunks'], 'readwrite');
  tx.objectStore('items').delete(id);
  tx.objectStore('thumbs').delete(id);
  tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
  return committed(tx);
}

export async function wipeAll() {
  const tx = (await db()).transaction(['meta', 'items', 'thumbs', 'chunks'], 'readwrite');
  for (const s of ['meta', 'items', 'thumbs', 'chunks']) tx.objectStore(s).clear();
  return committed(tx);
}
