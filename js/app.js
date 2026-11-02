import { createKey, unlockKey, rewrapKey, WrongPassphrase } from './crypto.js';
import * as db from './db.js';
import { addFile, listItems, readFile, readThumb, removeItem, typeOf, kindOf, extOf } from './vault.js';
import { buildBackup, importBackup, readBackupHeader } from './backup.js';
import { makeThumb, renderPdf } from './media.js';

const $ = (id) => document.getElementById(id);
const MIN_PASS = 10;
const HIDDEN_LOCK_MS = 30_000;   // lock if the app has been in the background this long
const BIG_FILE = 1024 ** 3;      // warn before opening files over 1 GB in the viewer

const state = {
  key: null,
  keyInfo: null,
  items: [],
  filter: 'all',
  query: '',
  selecting: false,
  selected: new Set(),
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
    input.autocomplete = f.type === 'password' ? 'off' : 'on';
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

// ---------- start-up, create, unlock, lock ----------

async function start() {
  if (!window.isSecureContext || !crypto.subtle) {
    document.body.textContent = 'Vault must be opened over HTTPS (or localhost) so encryption is available.';
    return;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  state.autoLockMs = Number(localStorage.getItem('autoLockMs')) || state.autoLockMs;
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

// ---------- library grid ----------

async function refresh() {
  state.items = await listItems(state.key);
  const live = new Set(state.items.map((i) => i.id));
  for (const [id, url] of state.thumbUrls) if (!live.has(id)) { URL.revokeObjectURL(url); state.thumbUrls.delete(id); }
  renderGrid();
  renderBanner();
}

function visibleItems() {
  const q = state.query.trim().toLowerCase();
  return state.items.filter((it) => {
    if (state.filter === 'image' && it.kind !== 'image') return false;
    if (state.filter === 'video' && it.kind !== 'video') return false;
    if (state.filter === 'docs' && (it.kind === 'image' || it.kind === 'video')) return false;
    return !q || it.name.toLowerCase().includes(q);
  });
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/></svg>',
};

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
  const items = visibleItems();
  $('empty').hidden = state.items.length > 0;
  thumbObserver.disconnect();

  grid.replaceChildren(...items.map((it) => {
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

  if (state.items.length && !items.length) {
    const p = document.createElement('p');
    p.className = 'muted no-results';
    p.textContent = 'Nothing matches.';
    grid.append(p);
  }
}

function renderBanner() {
  const unsaved = state.items.filter((i) => i.added > state.lastBackup).length;
  $('backup-banner').hidden = unsaved === 0;
  $('backup-banner-text').textContent =
    `${unsaved} item${unsaved === 1 ? ' isn\'t' : 's aren\'t'} in a backup yet.`;
}

$('grid').addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const id = tile.dataset.id;
  if (state.selecting) {
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    tile.classList.toggle('selected');
    updateSelectBar();
  } else {
    openViewer(id);
  }
});

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    state.filter = chip.dataset.filter;
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-selected', c === chip));
    renderGrid();
  });
}
$('search').addEventListener('input', (e) => { state.query = e.target.value; renderGrid(); });

// Selection mode
function setSelecting(on) {
  state.selecting = on;
  state.selected.clear();
  document.body.classList.toggle('selecting', on);
  $('select-btn').textContent = on ? 'Cancel' : 'Select';
  $('addbar').hidden = on;
  $('selectbar').hidden = !on;
  renderGrid();
  updateSelectBar();
}
function updateSelectBar() {
  $('sel-count').textContent = `${state.selected.size} selected`;
  $('sel-delete').disabled = state.selected.size === 0;
}
$('select-btn').addEventListener('click', () => setSelecting(!state.selecting));
$('sel-done').addEventListener('click', () => setSelecting(false));
$('sel-delete').addEventListener('click', async () => {
  const n = state.selected.size;
  if (!await confirmAsk({ title: `Delete ${n} item${n === 1 ? '' : 's'}?`, message: 'They will be removed from this vault permanently. Exported backups are not affected.', ok: 'Delete', danger: true })) return;
  await busy(async () => {
    let i = 0;
    for (const id of state.selected) { progress('Deleting…', ++i / n); await removeItem(id); }
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

function renderDetails(it) {
  const rows = [['Name', it.name], ['Type', it.type], ['Size', fmtSize(it.size)], ['Added', fmtDate(it.added)], ['File date', fmtDate(it.modified)]];
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

// Swipe left/right between items (not on PDFs/text, which scroll)
let touchStart = null;
$('v-stage').addEventListener('touchstart', (e) => {
  touchStart = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
$('v-stage').addEventListener('touchend', (e) => {
  if (!touchStart || !$('v-stage').querySelector('img.media')) return;
  const dx = e.changedTouches[0].clientX - touchStart.x;
  const dy = e.changedTouches[0].clientY - touchStart.y;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  touchStart = null;
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
}

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
