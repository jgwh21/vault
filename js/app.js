import { createKey, unlockKey, rewrapKey, randomId, WrongPassphrase } from './crypto.js';
import * as db from './db.js';
import {
  addFile, listItems, readFile, readThumb, removeItem, updateItem, setThumb, loadFolders, saveFolders, typeOf, kindOf, extOf,
} from './vault.js';
import { buildBackup, importBackup, readBackupHeader } from './backup.js';
import { makeThumb, renderPdf, videoFrameThumb } from './media.js';

// Must equal VERSION in sw.js and the app-version meta tag in index.html;
// `python build-upload.py --bump` updates all three, and the build refuses if they differ.
const APP_VERSION = 'vault-v8';

const $ = (id) => document.getElementById(id);
const MIN_PASS = 10;
const HIDDEN_LOCK_MS = 30_000;   // lock if the app has been in the background this long
const BIG_FILE = 1024 ** 3;      // warn before opening files over 1 GB in the viewer

const state = {
  key: null,
  keyInfo: null,
  items: [],
  folders: [],
  cwd: null,          // id of the folder being shown; null = top level
  filter: 'all',
  query: '',
  sort: 'added-desc',
  selecting: false,
  selected: new Set(),
  selectedFolders: new Set(),
  thumbUrls: new Map(),
  busy: false,        // long-running work in progress: don't auto-lock
  pickerOpen: false,  // system file picker showing: don't auto-lock
  autoLockMs: 300_000,
  lastActivity: Date.now(),
  hiddenAt: 0,
  lastBackup: 0,
};

// ---------- small helpers ----------

const fmtSize = (n) => {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
};
const fmtDate = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const isTouch = matchMedia('(pointer: coarse)').matches;

function show(screen) {
  for (const id of ['screen-setup', 'screen-lock', 'screen-main']) $(id).hidden = id !== screen;
}

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function progress(title, fraction, detail = '') {
  const p = $('progress');
  if (title === null) { p.hidden = true; return; }
  p.hidden = false;
  $('progress-title').textContent = title;
  $('progress-bar').style.width = `${Math.round((fraction || 0) * 100)}%`;
  $('progress-detail').textContent = detail;
}

async function busy(fn) {
  state.busy = true;
  try { return await fn(); }
  finally { state.busy = false; state.lastActivity = Date.now(); progress(null); }
}

/**
 * Modal prompt. fields: [{ name, label, type }]. `validate(values)` may return an
 * error message or a promise of one; the dialog stays open until it returns nothing.
 * Resolves to the values object, or null when cancelled.
 */
function ask({ title, message = '', fields = [], ok = 'OK', danger = false, validate }) {
  const dlg = $('ask');
  $('ask-title').textContent = title;
  $('ask-message').textContent = message;
  $('ask-message').hidden = !message;
  $('ask-error').hidden = true;
  $('ask-ok').textContent = ok;
  $('ask-ok').className = `btn ${danger ? 'danger' : 'primary'}`;
  const box = $('ask-fields');
  box.replaceChildren(...fields.map((f) => {
    const label = document.createElement('label');
    label.textContent = f.label;
    const input = document.createElement('input');
    input.type = f.type || 'text';
    input.name = f.name;
    input.autocomplete = 'off';
    input.value = f.value || '';
    input.required = true;
    label.append(input);
    return label;
  }));

  return new Promise((resolve) => {
    const finish = (value) => {
      $('ask-form').onsubmit = null;
      $('ask-cancel').onclick = null;
      dlg.oncancel = null;
      dlg.close();
      resolve(value);
    };
    $('ask-cancel').onclick = () => finish(null);
    dlg.oncancel = (e) => { e.preventDefault(); finish(null); };
    $('ask-form').onsubmit = async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(fields.map((f) => [f.name, box.querySelector(`[name="${f.name}"]`).value]));
      if (validate) {
        $('ask-ok').disabled = true;
        const err = await validate(values);
        $('ask-ok').disabled = false;
        if (err) { $('ask-error').textContent = err; $('ask-error').hidden = false; return; }
      }
      finish(values);
    };
    dlg.showModal();
    box.querySelector('input')?.focus();
  });
}

const confirmAsk = (opts) => ask(opts).then((v) => v !== null);

/** Hand a file to the user: share sheet on phones/tablets (Save to Files etc.), download elsewhere. */
async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (isTouch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return true;
}

function pickFile(input) {
  state.pickerOpen = true;
  input.value = '';
  input.click();
}
for (const id of ['media-input', 'files-input', 'backup-input']) {
  $(id).addEventListener('cancel', () => { state.pickerOpen = false; });
  $(id).addEventListener('change', () => { state.pickerOpen = false; });
}

// ---------- version & updates, shown on the lock and setup screens ----------
// iOS freezes a Home Screen app as soon as it's closed, so an update only downloads while
// Vault is open. Showing progress here tells you when it's safe to close.

function setUpdateStatus(text, working = false) {
  for (const el of document.querySelectorAll('.update-status')) {
    el.textContent = text ? `· ${text}` : '';
    el.classList.toggle('working', working);
  }
}

function watchInstall(worker, firstInstall) {
  const show = () => {
    if (worker.state === 'installing') {
      setUpdateStatus(firstInstall ? 'Saving for offline use, keep Vault open…' : 'Downloading update, keep Vault open…', true);
    } else if (worker.state === 'redundant') {
      setUpdateStatus('Update didn\'t finish, it will try again next time');
    } else if (worker.state === 'activated') {
      setUpdateStatus(firstInstall ? 'Ready to use offline' : 'Update installed, restarting…');
    }
  };
  worker.addEventListener('statechange', show);
  show();
}

async function startUpdates() {
  for (const el of document.querySelectorAll('.app-version')) el.textContent = `Version ${APP_VERSION.replace('vault-v', '')}`;
  if (!('serviceWorker' in navigator)) return;

  // When a new version takes over, switch to it straight away if locked; if unlocked,
  // don't interrupt (a reload would lock the vault), just say so.
  const hadVersion = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadVersion) return; // first install, not an update
    if (!state.key) location.reload();
    else toast('Vault has been updated. Lock it and open it again to use the new version.', 8000);
  });

  // Listen on the existing registration before asking for a check, so a download that
  // starts (or fails) in the meantime can't slip past and be reported as "Up to date".
  let reg = await navigator.serviceWorker.getRegistration().catch(() => null);
  const firstInstall = !reg?.active;
  if (!reg) {
    try {
      reg = await navigator.serviceWorker.register('sw.js');
    } catch {
      return;
    }
  }
  reg.addEventListener('updatefound', () => watchInstall(reg.installing, firstInstall));
  if (reg.installing) return watchInstall(reg.installing, firstInstall);

  setUpdateStatus('Checking for updates…', true);
  try {
    await reg.update(); // starts a fresh check even if one at launch already failed
  } catch {
    return setUpdateStatus('Offline, couldn\'t check for updates');
  }
  if (!reg.installing && !reg.waiting) setUpdateStatus('Up to date');
}

// ---------- start-up, create, unlock, lock ----------

async function start() {
  if (!window.isSecureContext || !crypto.subtle) {
    document.body.textContent = 'Vault must be opened over HTTPS (or localhost) so encryption is available.';
    return;
  }
  startUpdates();
  state.autoLockMs = Number(localStorage.getItem('autoLockMs')) || state.autoLockMs;
  try { if (SORTS[localStorage.getItem('sort')]) state.sort = localStorage.getItem('sort'); } catch {}
  $('sort').value = state.sort;
  state.keyInfo = await db.get('meta', 'keyInfo');
  if (state.keyInfo) {
    show('screen-lock');
    $('unlock-pass').focus();
  } else {
    show('screen-setup');
  }
}

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $('create-pass').value;
  if (pass.length < MIN_PASS) return toast(`Use at least ${MIN_PASS} characters.`);
  if (pass !== $('create-pass2').value) return toast('The passphrases don\'t match.');
  await busy(async () => {
    progress('Creating your vault…', 0.5);
    const { keyInfo, key } = await createKey(pass);
    await db.set('meta', 'keyInfo', keyInfo);
    $('create-form').reset();
    await enter(key, keyInfo);
  });
});

$('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('unlock-form').querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Unlocking…';
  $('unlock-error').hidden = true;
  try {
    const key = await unlockKey(state.keyInfo, $('unlock-pass').value);
    $('unlock-pass').value = '';
    await enter(key, state.keyInfo);
  } catch (err) {
    $('unlock-error').textContent = err instanceof WrongPassphrase ? 'Wrong passphrase.' : err.message;
    $('unlock-error').hidden = false;
    $('unlock-pass').select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
});

async function enter(key, keyInfo) {
  state.key = key;
  state.keyInfo = keyInfo;
  state.lastBackup = (await db.get('meta', 'lastBackup')) || 0;
  state.lastActivity = Date.now();
  navigator.storage?.persist?.().catch(() => {});
  await refresh();
  show('screen-main');
}

function lock() {
  // A reload is the surest way to drop the key and every decrypted image from memory.
  state.key = null;
  location.reload();
}
$('lock-btn').addEventListener('click', lock);

// Restore from backup on a brand-new install
$('restore-btn').addEventListener('click', () => pickFile($('backup-input')));

$('backup-input').addEventListener('change', async () => {
  const file = $('backup-input').files[0];
  if (!file) return;
  try {
    const { header } = await readBackupHeader(file);
    const fresh = !state.key;
    const values = await ask({
      title: fresh ? 'Restore backup' : 'Import backup',
      message: `Backup from ${fmtDate(header.created)} with ${header.items} item(s). Enter the passphrase the vault had when this backup was made.`,
      fields: [{ name: 'pass', label: 'Backup passphrase', type: 'password' }],
      ok: fresh ? 'Restore' : 'Import',
    });
    if (!values) return;
    await busy(async () => {
      progress('Checking passphrase…', 0);
      const result = await importBackup(file, {
        passphrase: values.pass,
        currentKey: state.key,
        currentKeyInfo: state.key ? state.keyInfo : null,
        onProgress: (f) => progress(fresh ? 'Restoring backup…' : 'Importing backup…', f, `${Math.round(f * 100)}%`),
      });
      if (fresh) {
        await enter(result.key, result.keyInfo);
        toast(`Restored ${result.added} item(s). Your passphrase is the backup's passphrase.`, 6000);
      } else {
        await refresh();
        toast(`Imported ${result.added} item(s)${result.skipped ? `, ${result.skipped} already here` : ''}.`);
      }
    });
  } catch (err) {
    toast(err instanceof WrongPassphrase ? 'Wrong passphrase for that backup.' : err.message, 5000);
  }
});

// ---------- auto-lock & privacy shield ----------

for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
  addEventListener(ev, () => { state.lastActivity = Date.now(); }, { passive: true });
}

setInterval(() => {
  if (!state.key) return;
  const playing = [...document.querySelectorAll('video, audio')].some((m) => !m.paused);
  if (playing || state.busy || state.pickerOpen) state.lastActivity = Date.now();
  if (Date.now() - state.lastActivity > state.autoLockMs) lock();
}, 10_000);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Hide content before iOS takes the app-switcher snapshot.
    document.body.classList.add('shielded');
    state.hiddenAt = Date.now();
  } else {
    document.body.classList.remove('shielded');
    if (state.key && !state.busy && !state.pickerOpen && Date.now() - state.hiddenAt > HIDDEN_LOCK_MS) lock();
  }
});

// ---------- folders ----------

const folderById = (id) => (id ? state.folders.find((f) => f.id === id) : undefined);
const parentOf = (x) => (folderById(x.parent) ? x.parent : null);
const folderOf = (it) => (folderById(it.folder) ? it.folder : null);
const subfolders = (parent) => state.folders
  .filter((f) => parentOf(f) === parent)
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

function folderPath(id) {
  const path = [];
  for (let f = folderById(id); f && path.length < 50; f = folderById(f.parent)) path.unshift(f);
  return path;
}
const pathLabel = (id) => (id ? folderPath(id).map((f) => f.name).join(' / ') : 'Vault (top level)');

function withDescendants(id) {
  const out = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of state.folders) if (!out.has(f.id) && out.has(f.parent)) { out.add(f.id); grew = true; }
  }
  return out;
}

const countIn = (id) => subfolders(id).length + state.items.filter((it) => folderOf(it) === id).length;

function folderNameError(name, parent, selfId) {
  const n = name.trim();
  if (!n) return 'Enter a name.';
  if (n.length > 60) return 'Keep the name under 60 characters.';
  if (subfolders(parent).some((f) => f.id !== selfId && f.name.toLowerCase() === n.toLowerCase())) {
    return 'There is already a folder with that name here.';
  }
}

function openFolder(id) {
  state.cwd = id;
  state.query = '';
  $('search').value = '';
  renderGrid();
  scrollTo(0, 0);
}

/** Delete a folder record; anything inside it moves up to the folder's parent. */
async function removeFolder(id) {
  const f = folderById(id);
  if (!f) return;
  const parent = parentOf(f);
  for (const sub of state.folders) if (sub.parent === id) sub.parent = parent;
  for (const it of state.items) {
    if (folderOf(it) === id) { it.folder = parent; await updateItem(state.key, it); }
  }
  state.folders = state.folders.filter((x) => x.id !== id);
  await saveFolders(state.key, state.folders);
}

/** Ask where to move things. Resolves to a folder id, null for top level, or undefined if cancelled. */
function chooseFolder(exclude) {
  const dlg = $('move');
  const list = $('move-list');
  const option = (id, name, depth) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'move-opt';
    b.style.paddingLeft = `${12 + depth * 20}px`;
    b.dataset.id = id ?? '';
    b.innerHTML = ICONS.folder;
    b.append(name);
    return b;
  };
  const rows = [option(null, 'Vault (top level)', 0)];
  const walk = (parent, depth) => {
    for (const f of subfolders(parent)) {
      if (exclude.has(f.id)) continue;
      rows.push(option(f.id, f.name, depth));
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  list.replaceChildren(...rows);

  return new Promise((resolve) => {
    const finish = (value) => {
      list.onclick = null;
      $('move-cancel').onclick = null;
      dlg.oncancel = null;
      dlg.close();
      resolve(value);
    };
    list.onclick = (e) => {
      const b = e.target.closest('.move-opt');
      if (b) finish(b.dataset.id || null);
    };
    $('move-cancel').onclick = () => finish(undefined);
    dlg.oncancel = (e) => { e.preventDefault(); finish(undefined); };
    dlg.showModal();
  });
}

$('new-folder-btn').addEventListener('click', async () => {
  const parent = state.cwd;
  const values = await ask({
    title: 'New folder',
    message: parent ? `Inside ${pathLabel(parent)}` : '',
    fields: [{ name: 'name', label: 'Folder name' }],
    ok: 'Create',
    validate: (v) => folderNameError(v.name, parent),
  });
  if (!values) return;
  state.folders.push({ id: randomId(), name: values.name.trim(), parent, created: Date.now() });
  await saveFolders(state.key, state.folders);
  renderGrid();
});

$('folder-rename').addEventListener('click', async () => {
  const f = folderById(state.cwd);
  if (!f) return;
  const values = await ask({
    title: 'Rename folder',
    fields: [{ name: 'name', label: 'Folder name', value: f.name }],
    ok: 'Rename',
    validate: (v) => folderNameError(v.name, parentOf(f), f.id),
  });
  if (!values) return;
  f.name = values.name.trim();
  await saveFolders(state.key, state.folders);
  renderGrid();
});

$('folder-delete').addEventListener('click', async () => {
  const f = folderById(state.cwd);
  if (!f) return;
  const n = countIn(f.id);
  if (!await confirmAsk({
    title: `Delete folder "${f.name}"?`,
    message: n
      ? `Its ${n} item(s) won't be deleted. They move up to ${pathLabel(parentOf(f))}.`
      : 'The folder is empty.',
    ok: 'Delete folder',
    danger: true,
  })) return;
  const parent = parentOf(f);
  await busy(() => removeFolder(f.id));
  state.cwd = parent;
  await refresh();
});

// ---------- library grid ----------

async function refresh() {
  state.items = await listItems(state.key);
  state.folders = await loadFolders(state.key);
  if (!folderById(state.cwd)) state.cwd = null;
  const live = new Set(state.items.map((i) => i.id));
  for (const [id, url] of state.thumbUrls) if (!live.has(id)) { URL.revokeObjectURL(url); state.thumbUrls.delete(id); }
  renderGrid();
  renderBanner();
}

// Searching looks through every folder; otherwise only the current folder is shown.
function visibleItems() {
  const q = state.query.trim().toLowerCase();
  return state.items.filter((it) => {
    if (state.filter === 'image' && it.kind !== 'image') return false;
    if (state.filter === 'video' && it.kind !== 'video') return false;
    if (state.filter === 'docs' && (it.kind === 'image' || it.kind === 'video')) return false;
    return q ? it.name.toLowerCase().includes(q) : folderOf(it) === state.cwd;
  }).sort(SORTS[state.sort] || SORTS['added-desc']);
}

// Folders always come first, by name (reversed for Name Z–A); items follow the chosen sort.
function visibleFolders() {
  const q = state.query.trim().toLowerCase();
  const folders = q ? state.folders.filter((f) => f.name.toLowerCase().includes(q)) : subfolders(state.cwd);
  const byName = folders.sort((a, b) => byText(a.name, b.name));
  return state.sort === 'name-desc' ? byName.reverse() : byName;
}

const byText = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const SORTS = {
  'added-desc': (a, b) => b.added - a.added,
  'added-asc': (a, b) => a.added - b.added,
  'date-desc': (a, b) => b.modified - a.modified || b.added - a.added,
  'date-asc': (a, b) => a.modified - b.modified || a.added - b.added,
  'name-asc': (a, b) => byText(a.name, b.name),
  'name-desc': (a, b) => byText(b.name, a.name),
  'size-desc': (a, b) => b.size - a.size,
  'size-asc': (a, b) => a.size - b.size,
};

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};

function renderCrumbs() {
  const inFolder = state.cwd !== null && !state.query.trim();
  $('crumbs').hidden = !inFolder;
  if (!inFolder) return;
  const parts = [{ id: null, name: 'Vault' }, ...folderPath(state.cwd)];
  $('crumb-list').replaceChildren(...parts.flatMap((p, i) => {
    const last = i === parts.length - 1;
    const el = document.createElement(last ? 'span' : 'button');
    el.className = last ? 'crumb current' : 'crumb';
    el.textContent = p.name;
    if (!last) { el.type = 'button'; el.onclick = () => openFolder(p.id); }
    if (!i) return [el];
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '›';
    return [sep, el];
  }));
}

function folderTile(f) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile folder';
  tile.dataset.folder = f.id;
  tile.setAttribute('aria-label', `Folder ${f.name}`);
  if (state.selectedFolders.has(f.id)) tile.classList.add('selected');
  const art = document.createElement('div');
  art.className = 'tile-art';
  art.innerHTML = ICONS.folder;
  const count = document.createElement('span');
  count.className = 'tile-ext';
  const n = countIn(f.id);
  count.textContent = `${n} item${n === 1 ? '' : 's'}`;
  art.append(count);
  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = f.name;
  const check = document.createElement('span');
  check.className = 'check';
  tile.append(art, name, check);
  return tile;
}

const thumbObserver = new IntersectionObserver((entries) => {
  for (const { target, isIntersecting } of entries) {
    if (!isIntersecting) continue;
    thumbObserver.unobserve(target);
    loadThumb(target);
  }
}, { rootMargin: '300px' });

async function loadThumb(tile) {
  const id = tile.dataset.id;
  let url = state.thumbUrls.get(id);
  if (!url) {
    const blob = await readThumb(state.key, id).catch(() => null);
    if (!blob) return;
    url = URL.createObjectURL(blob);
    state.thumbUrls.set(id, url);
  }
  const img = document.createElement('img');
  img.alt = '';
  img.src = url;
  tile.querySelector('.tile-art').replaceChildren(img);
}

function renderGrid() {
  const grid = $('grid');
  const folders = visibleFolders();
  const items = visibleItems();
  thumbObserver.disconnect();
  renderCrumbs();

  grid.replaceChildren(...folders.map(folderTile), ...items.map((it) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `tile kind-${it.kind}`;
    tile.dataset.id = it.id;
    tile.setAttribute('aria-label', it.name);
    if (state.selected.has(it.id)) tile.classList.add('selected');

    const art = document.createElement('div');
    art.className = 'tile-art';
    if (it.kind !== 'image' && it.kind !== 'video' || !it.hasThumb) {
      art.innerHTML = it.kind === 'video' ? ICONS.play : ICONS.doc;
      const ext = document.createElement('span');
      ext.className = 'tile-ext';
      ext.textContent = (extOf(it.name) || it.kind).toUpperCase();
      art.append(ext);
    }
    tile.append(art);

    if (it.kind === 'video') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.innerHTML = ICONS.play;
      tile.append(badge);
    }
    if (it.kind !== 'image' && it.kind !== 'video') {
      const name = document.createElement('span');
      name.className = 'tile-name';
      name.textContent = it.name;
      tile.append(name);
    }
    const check = document.createElement('span');
    check.className = 'check';
    tile.append(check);

    if (it.hasThumb) thumbObserver.observe(tile);
    return tile;
  }));

  const nothing = !folders.length && !items.length;
  const filtered = state.query.trim() || state.filter !== 'all';
  $('empty').hidden = !nothing;
  $('empty-title').textContent = filtered ? 'Nothing matches.'
    : state.cwd ? 'This folder is empty.' : 'Your vault is empty.';
  $('empty-text').textContent = filtered ? ''
    : state.cwd ? 'Add photos or files here, or move items in with Select → Move.'
      : 'Add photos and videos from your library, or documents from Files. Use the folder button to organise them.';
}

function renderBanner() {
  const unsaved = state.items.filter((i) => i.added > state.lastBackup).length;
  $('backup-banner').hidden = unsaved === 0;
  $('backup-banner-text').textContent =
    `${unsaved} item${unsaved === 1 ? ' isn\'t' : 's aren\'t'} in a backup yet.`;
}

$('grid').addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || Date.now() - drag.endedAt < 400) return; // the click that ends a drag-select
  if (state.selecting) {
    setTileSelected(tile, !isTileSelected(tile));
    return updateSelectBar();
  }
  if (tile.dataset.folder) openFolder(tile.dataset.folder);
  else openViewer(tile.dataset.id);
});

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    state.filter = chip.dataset.filter;
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-selected', c === chip));
    renderGrid();
  });
}
$('search').addEventListener('input', (e) => { state.query = e.target.value; renderGrid(); });
$('sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  try { localStorage.setItem('sort', state.sort); } catch {}
  renderGrid();
});

// Selection mode
function setSelecting(on) {
  state.selecting = on;
  state.selected.clear();
  state.selectedFolders.clear();
  document.body.classList.toggle('selecting', on);
  $('select-btn').textContent = on ? 'Cancel' : 'Select';
  $('addbar').hidden = on;
  $('selectbar').hidden = !on;
  renderGrid();
  updateSelectBar();
}
function updateSelectBar() {
  const n = state.selected.size + state.selectedFolders.size;
  $('sel-count').textContent = `${n} selected`;
  $('sel-delete').disabled = n === 0;
  $('sel-move').disabled = n === 0;
}
$('select-btn').addEventListener('click', () => setSelecting(!state.selecting));
$('sel-done').addEventListener('click', () => setSelecting(false));

const selectionSet = (tile) => (tile.dataset.folder ? state.selectedFolders : state.selected);
const tileId = (tile) => tile.dataset.folder || tile.dataset.id;
const isTileSelected = (tile) => selectionSet(tile).has(tileId(tile));
function setTileSelected(tile, on) {
  on ? selectionSet(tile).add(tileId(tile)) : selectionSet(tile).delete(tileId(tile));
  tile.classList.toggle('selected', on);
}

// Drag to select, like the Photos app: in select mode, slide sideways from a tile (or drag
// with the mouse) and every tile between it and your finger is selected, in grid order.
// Starting on a selected tile deselects instead. Moving up/down first scrolls as normal;
// while dragging, holding near the top or bottom of the screen scrolls the grid.
const drag = { pending: null, active: false, tiles: [], anchor: -1, adding: true, base: null, last: -1, x: 0, y: 0, raf: 0, endedAt: 0 };
const DRAG_START_PX = 10;
const EDGE_PX = 90;

function dragStart() {
  drag.tiles = [...$('grid').querySelectorAll('.tile')];
  drag.anchor = drag.tiles.indexOf(drag.pending.tile);
  drag.adding = !isTileSelected(drag.pending.tile);
  drag.base = drag.tiles.map(isTileSelected);
  drag.pending = null;
  drag.active = true;
  drag.last = -1;
  drag.raf = requestAnimationFrame(dragAutoScroll);
}

function dragMove(x, y) {
  drag.x = x;
  drag.y = y;
  const i = drag.tiles.indexOf(document.elementFromPoint(x, y)?.closest('#grid .tile'));
  if (i < 0 || i === drag.last) return;
  drag.last = i;
  const lo = Math.min(i, drag.anchor), hi = Math.max(i, drag.anchor);
  drag.tiles.forEach((t, k) => setTileSelected(t, k >= lo && k <= hi ? drag.adding : drag.base[k]));
  updateSelectBar();
}

function dragEnd(e) {
  // A mouse drag ends with a click on the last tile, which must not toggle it again.
  // (A finger drag produces no click, so a quick tap afterwards still counts.)
  if (drag.active && e.type === 'mouseup') drag.endedAt = Date.now();
  drag.active = false;
  drag.pending = null;
  cancelAnimationFrame(drag.raf);
}

function dragAutoScroll() {
  if (!drag.active) return;
  const bottom = innerHeight - $('selectbar').offsetHeight;
  const speed = drag.y < EDGE_PX ? -(EDGE_PX - drag.y) / 4 : drag.y > bottom - EDGE_PX ? (drag.y - (bottom - EDGE_PX)) / 4 : 0;
  if (speed) {
    scrollBy(0, speed);
    drag.last = -1; // the tile under the finger may have changed
    dragMove(drag.x, drag.y);
  }
  drag.raf = requestAnimationFrame(dragAutoScroll);
}

$('grid').addEventListener('touchstart', (e) => {
  const tile = e.target.closest('.tile');
  drag.pending = state.selecting && tile && e.touches.length === 1
    ? { tile, x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
$('grid').addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (drag.pending) {
    const dx = Math.abs(t.clientX - drag.pending.x), dy = Math.abs(t.clientY - drag.pending.y);
    if (dy > DRAG_START_PX && dy > dx) { drag.pending = null; return; } // vertical: let it scroll
    if (dx < DRAG_START_PX) return;
    dragStart();
  }
  if (!drag.active) return;
  e.preventDefault(); // stop the page scrolling under the finger while selecting
  dragMove(t.clientX, t.clientY);
}, { passive: false });
$('grid').addEventListener('touchend', dragEnd);
$('grid').addEventListener('touchcancel', dragEnd);

$('grid').addEventListener('mousedown', (e) => {
  const tile = e.target.closest('.tile');
  if (state.selecting && tile && e.button === 0) {
    drag.pending = { tile, x: e.clientX, y: e.clientY };
    e.preventDefault(); // no text selection while dragging
  }
});
addEventListener('mousemove', (e) => {
  if (drag.pending && Math.hypot(e.clientX - drag.pending.x, e.clientY - drag.pending.y) > DRAG_START_PX) dragStart();
  if (drag.active) dragMove(e.clientX, e.clientY);
});
addEventListener('mouseup', dragEnd);

$('sel-move').addEventListener('click', async () => {
  const exclude = new Set();
  for (const id of state.selectedFolders) for (const d of withDescendants(id)) exclude.add(d);
  const target = await chooseFolder(exclude); // a folder can't go inside itself
  if (target === undefined) return;
  await busy(async () => {
    const n = state.selected.size;
    let i = 0;
    for (const id of state.selected) {
      progress('Moving…', ++i / n);
      const it = state.items.find((x) => x.id === id);
      if (it && folderOf(it) !== target) { it.folder = target; await updateItem(state.key, it); }
    }
    for (const id of state.selectedFolders) { const f = folderById(id); if (f) f.parent = target; }
    if (state.selectedFolders.size) await saveFolders(state.key, state.folders);
  });
  setSelecting(false);
  await refresh();
  toast(`Moved to ${pathLabel(target)}.`);
});

$('sel-delete').addEventListener('click', async () => {
  const ni = state.selected.size;
  const nf = state.selectedFolders.size;
  const what = [ni && `${ni} item${ni === 1 ? '' : 's'}`, nf && `${nf} folder${nf === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
  const message = [
    ni && 'Items are removed from this vault permanently. Exported backups are not affected.',
    nf && 'Deleting a folder doesn\'t delete what\'s inside it; its contents move up one level.',
  ].filter(Boolean).join('\n\n');
  if (!await confirmAsk({ title: `Delete ${what}?`, message, ok: 'Delete', danger: true })) return;
  await busy(async () => {
    let i = 0;
    for (const id of state.selected) { progress('Deleting…', ++i / ni); await removeItem(id); }
    state.items = await listItems(state.key);
    for (const id of state.selectedFolders) await removeFolder(id);
  });
  setSelecting(false);
  await refresh();
});

// ---------- adding files ----------

$('add-media').addEventListener('click', () => pickFile($('media-input')));
$('add-files').addEventListener('click', () => pickFile($('files-input')));
$('media-input').addEventListener('change', (e) => addFiles([...e.target.files]));
$('files-input').addEventListener('change', (e) => addFiles([...e.target.files]));

let originalsHintShown = false;

async function addFiles(files) {
  if (!files.length) return;
  const total = files.reduce((s, f) => s + f.size, 0);
  const est = await navigator.storage?.estimate?.().catch(() => null);
  if (est?.quota && est.usage + total * 1.02 > est.quota) {
    toast(`Not enough storage: need ${fmtSize(total)}, about ${fmtSize(est.quota - est.usage)} available.`, 6000);
    return;
  }

  const failed = [];
  await busy(async () => {
    let done = 0;
    for (const [i, file] of files.entries()) {
      const label = `Encrypting ${i + 1} of ${files.length}`;
      progress(label, done / total, file.name);
      try {
        const thumb = await makeThumb(file, kindOf(typeOf(file)));
        await addFile(state.key, file, {
          thumb,
          folder: state.cwd,
          onProgress: (bytes) => progress(label, (done + bytes) / (total || 1), file.name),
        });
      } catch (err) {
        failed.push(`${file.name}: ${err.message}`);
      }
      done += file.size;
    }
  });
  await refresh();

  const ok = files.length - failed.length;
  if (failed.length) {
    await ask({ title: `${failed.length} file(s) could not be added`, message: failed.join('\n'), ok: 'OK' });
  } else if (!originalsHintShown && isTouch) {
    originalsHintShown = true;
    toast(`Added ${ok} item(s). The originals are still in Photos/Files; delete them there if you only want them here.`, 7000);
  } else {
    toast(`Added ${ok} item(s).`);
  }
}

// ---------- viewer ----------

const viewer = { index: -1, list: [], blob: null, url: null, cleanup: null, token: 0 };

function clearStage() {
  viewer.cleanup?.();
  viewer.cleanup = null;
  if (viewer.url) URL.revokeObjectURL(viewer.url);
  viewer.url = null;
  viewer.blob = null;
  $('v-stage').replaceChildren();
}

async function openViewer(id) {
  viewer.list = visibleItems();
  viewer.index = viewer.list.findIndex((i) => i.id === id);
  $('viewer').hidden = false;
  document.body.classList.add('viewing');
  await showCurrent();
}

function closeViewer() {
  viewer.token++;
  clearStage();
  $('viewer').hidden = true;
  $('v-details').hidden = true;
  document.body.classList.remove('viewing');
}

function message(text, extra) {
  const box = document.createElement('div');
  box.className = 'viewer-message';
  const p = document.createElement('p');
  p.textContent = text;
  box.append(p);
  if (extra) box.append(extra);
  return box;
}

async function showCurrent() {
  const it = viewer.list[viewer.index];
  if (!it) return closeViewer();
  const token = ++viewer.token;
  clearStage();
  const stage = $('v-stage');
  $('v-title').textContent = it.name;
  $('v-prev').hidden = viewer.index <= 0;
  $('v-next').hidden = viewer.index >= viewer.list.length - 1;
  renderDetails(it);

  if (it.size > BIG_FILE && !await confirmAsk({
    title: 'Large file',
    message: `${it.name} is ${fmtSize(it.size)}. Opening it needs that much free memory and may fail on a phone. Open anyway?`,
    ok: 'Open',
  })) {
    if (token === viewer.token) stage.replaceChildren(message('Not opened. Use the save button to copy it out instead.'));
    return;
  }

  const loading = message('Decrypting…');
  stage.replaceChildren(loading);
  let blob;
  try {
    blob = await readFile(state.key, it, (f) => {
      if (it.chunks > 2) loading.firstChild.textContent = `Decrypting… ${Math.round(f * 100)}%`;
    });
  } catch (err) {
    if (token === viewer.token) stage.replaceChildren(message(`Could not decrypt this file: ${err.message}`));
    return;
  }
  if (token !== viewer.token) return;
  viewer.blob = blob;
  viewer.url = URL.createObjectURL(blob);

  const unsupported = () => message('This format can\'t be shown on this device. Use the save button to open it in another app.');

  if (it.kind === 'image') {
    const img = document.createElement('img');
    img.className = 'media';
    img.alt = it.name;
    img.src = viewer.url;
    img.onerror = () => stage.replaceChildren(unsupported());
    stage.replaceChildren(img);
  } else if (it.kind === 'video' || it.kind === 'audio') {
    const media = document.createElement(it.kind);
    media.className = 'media';
    media.controls = true;
    media.playsInline = true;
    media.preload = 'metadata';
    media.src = viewer.url;
    media.onerror = () => stage.replaceChildren(unsupported());
    stage.replaceChildren(media);
    viewer.cleanup = () => { media.pause(); media.removeAttribute('src'); media.load(); };
    if (it.kind === 'video' && !it.hasThumb) saveThumbWhenShown(media, it);
  } else if (it.kind === 'pdf') {
    const pages = document.createElement('div');
    pages.className = 'pdf';
    stage.replaceChildren(pages);
    try {
      const pdf = await renderPdf(blob, pages);
      if (token !== viewer.token) return pdf.destroy();
      viewer.cleanup = () => pdf.destroy();
    } catch (err) {
      stage.replaceChildren(message(`Could not open this PDF: ${err.message}`));
    }
  } else if (it.kind === 'text') {
    const limit = 2 * 1024 * 1024;
    const pre = document.createElement('pre');
    pre.className = 'text';
    pre.textContent = await blob.slice(0, limit).text();
    if (blob.size > limit) pre.textContent += '\n\n… (only the first 2 MB is shown)';
    stage.replaceChildren(pre);
  } else {
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = isTouch ? 'Open in another app' : 'Save a copy';
    btn.onclick = saveCopy;
    stage.replaceChildren(message(`${extOf(it.name).toUpperCase() || 'This'} files can't be previewed inside Vault.`, btn));
  }
}

// A video whose preview couldn't be made on import gets one from the viewer: once a real frame
// is on screen (when it loads, or after a moment of playing), it is saved as the thumbnail.
function saveThumbWhenShown(video, it) {
  let done = false;
  const tryFrame = async () => {
    if (done || !state.key || !video.videoWidth) return;
    const thumb = await videoFrameThumb(video);
    if (!thumb || done) return;
    done = true;
    video.removeEventListener('loadeddata', tryFrame);
    video.removeEventListener('timeupdate', onTime);
    await setThumb(state.key, it, thumb).catch(() => {});
    renderGrid();
  };
  const onTime = () => { if (video.currentTime > 0.5) tryFrame(); };
  video.addEventListener('loadeddata', tryFrame);
  video.addEventListener('timeupdate', onTime);
}

function renderDetails(it) {
  const rows = [['Name', it.name], ['Folder', pathLabel(folderOf(it))], ['Type', it.type], ['Size', fmtSize(it.size)], ['Added', fmtDate(it.added)], ['File date', fmtDate(it.modified)]];
  const dl = document.createElement('dl');
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
  $('v-details').replaceChildren(dl);
}

async function saveCopy() {
  const it = viewer.list[viewer.index];
  if (!viewer.blob || !it) return;
  if (!await confirmAsk({
    title: 'Save an unencrypted copy?',
    message: 'The copy will be outside the vault and readable by anyone with access to where you save it.',
    ok: 'Continue',
  })) return;
  await deliver(viewer.blob, it.name);
}

const step = (d) => {
  const next = viewer.index + d;
  if (next < 0 || next >= viewer.list.length) return;
  viewer.index = next;
  showCurrent();
};

$('v-close').addEventListener('click', closeViewer);
$('v-prev').addEventListener('click', () => step(-1));
$('v-next').addEventListener('click', () => step(1));
$('v-info').addEventListener('click', () => { $('v-details').hidden = !$('v-details').hidden; });
$('v-save').addEventListener('click', saveCopy);
$('v-delete').addEventListener('click', async () => {
  const it = viewer.list[viewer.index];
  if (!await confirmAsk({ title: 'Delete this item?', message: `${it.name} will be removed from this vault permanently.`, ok: 'Delete', danger: true })) return;
  await removeItem(it.id);
  viewer.list.splice(viewer.index, 1);
  await refresh();
  if (!viewer.list.length) return closeViewer();
  viewer.index = Math.min(viewer.index, viewer.list.length - 1);
  showCurrent();
});

addEventListener('keydown', (e) => {
  if ($('viewer').hidden || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') closeViewer();
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});

// Swipe left/right between items of every kind. A mostly-horizontal swipe changes item;
// vertical scrolling (PDFs, text) is unaffected. Swipes that start on a player's control
// bar are left alone so dragging the video/audio position slider doesn't change item.
const PLAYER_CONTROLS_HEIGHT = 70;
let touchStart = null;
$('v-stage').addEventListener('touchstart', (e) => {
  touchStart = null;
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  const media = e.target.closest('video, audio');
  if (media && (media.tagName === 'AUDIO' || t.clientY > media.getBoundingClientRect().bottom - PLAYER_CONTROLS_HEIGHT)) return;
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });
$('v-stage').addEventListener('touchend', (e) => {
  if (!touchStart) return;
  const dx = e.changedTouches[0].clientX - touchStart.x;
  const dy = e.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if ((window.visualViewport?.scale || 1) > 1.05) return; // pinch-zoomed in: the swipe is panning
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
});

// ---------- settings ----------

async function renderSettings() {
  $('backup-status').textContent = state.lastBackup
    ? `Last backup: ${fmtDate(state.lastBackup)}.`
    : 'You haven\'t made a backup yet.';
  $('autolock').value = String(state.autoLockMs);

  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const total = state.items.reduce((s, i) => s + i.size, 0);
  $('storage-status').textContent = [
    `${state.items.length} item(s), ${fmtSize(total)}.`,
    est?.quota ? `Space available to Vault: about ${fmtSize(Math.max(0, est.quota - est.usage))}.` : '',
    persisted ? 'Storage is marked persistent.' : 'Storage is not marked persistent: on iPhone, add Vault to your Home Screen and open it from there.',
  ].filter(Boolean).join(' ');

  // The version of the code that is actually running. If the page itself came from a different
  // version, an update didn't install cleanly; say so rather than hide it.
  const pageVersion = document.querySelector('meta[name="app-version"]')?.content;
  $('version-status').textContent = `Installed version: ${APP_VERSION.replace('vault-v', '')}.`
    + (pageVersion === APP_VERSION ? ''
      : ' Some files are from another version: open Vault again while online, or tap Check for updates.');
}

$('update-btn').addEventListener('click', async () => {
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => null);
  if (!reg) return toast('Updates need the app to be opened from its web address first.');
  const btn = $('update-btn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    await reg.update();
    toast(reg.installing || reg.waiting
      ? 'Downloading the update. Lock Vault and open it again in a moment.'
      : 'You have the latest version.', 6000);
  } catch {
    toast('Couldn\'t check for updates. Are you online?');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check for updates';
  }
});

$('settings-btn').addEventListener('click', async () => {
  await renderSettings();
  $('settings').showModal();
});
$('backup-banner-btn').addEventListener('click', async () => {
  await renderSettings();
  $('settings').showModal();
});
$('settings').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]') || e.target === $('settings')) $('settings').close();
});

$('autolock').addEventListener('change', (e) => {
  state.autoLockMs = Number(e.target.value);
  try { localStorage.setItem('autoLockMs', e.target.value); } catch {}
});

$('export-btn').addEventListener('click', async () => {
  if (!state.items.length) return toast('Nothing to back up yet.');
  const { blob, count } = await busy(() => buildBackup(state.keyInfo, (f) => progress('Preparing backup…', f)));
  const name = `vault-backup-${new Date().toISOString().slice(0, 10)}.pvault`;
  // Sharing must start from a fresh tap on iOS, so ask once the file is ready.
  if (!await confirmAsk({
    title: 'Backup ready',
    message: `${count} item(s), ${fmtSize(blob.size)}. ${isTouch ? 'Choose "Save to Files" (or another place) in the next screen.' : 'It will be saved to your downloads.'}`,
    ok: 'Save backup',
  })) return;
  if (await deliver(blob, name)) {
    state.lastBackup = Date.now();
    await db.set('meta', 'lastBackup', state.lastBackup);
    renderBanner();
    renderSettings();
  }
});

$('import-btn').addEventListener('click', () => pickFile($('backup-input')));

$('change-pass-btn').addEventListener('click', async () => {
  const values = await ask({
    title: 'Change passphrase',
    message: 'Backups you already exported keep the passphrase they were made with.',
    fields: [
      { name: 'old', label: 'Current passphrase', type: 'password' },
      { name: 'next', label: 'New passphrase', type: 'password' },
      { name: 'again', label: 'Confirm new passphrase', type: 'password' },
    ],
    ok: 'Change',
    validate: async (v) => {
      if (v.next.length < MIN_PASS) return `Use at least ${MIN_PASS} characters.`;
      if (v.next !== v.again) return 'The new passphrases don\'t match.';
      try {
        const keyInfo = await rewrapKey(state.keyInfo, v.old, v.next);
        await db.set('meta', 'keyInfo', keyInfo);
        state.keyInfo = keyInfo;
      } catch (err) {
        return err instanceof WrongPassphrase ? 'Current passphrase is wrong.' : err.message;
      }
    },
  });
  if (values) toast('Passphrase changed.');
});

$('wipe-btn').addEventListener('click', async () => {
  const values = await ask({
    title: 'Erase vault?',
    message: `This permanently deletes all ${state.items.length} item(s) on this device. Type ERASE to confirm.`,
    fields: [{ name: 'word', label: 'Type ERASE', type: 'text' }],
    ok: 'Erase everything',
    danger: true,
    validate: (v) => (v.word.trim() === 'ERASE' ? null : 'Type ERASE in capitals to confirm.'),
  });
  if (!values) return;
  await db.wipeAll();
  location.reload();
});

start();
