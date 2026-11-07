// Caches the app's own files so Vault opens with no internet connection.
// Bump VERSION whenever any file changes so installed copies pick up the update
// (run `python build-upload.py --bump`, which also updates the stamps below).
const VERSION = 'vault-v9';
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/crypto.js', 'js/db.js', 'js/vault.js', 'js/backup.js', 'js/media.js',
  'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];
// Files that carry VERSION as a stamp. If the host serves a copy without it (an upload that
// missed a file, or one that hasn't finished publishing), installing fails and the previous
// version keeps running; the next launch tries again. This stops a mixed set being saved.
const STAMPED = ['index.html', 'js/app.js'];

// A download that stalls (weak signal) must fail rather than hang, so the app can say so and
// the next launch tries again.
const INSTALL_TIMEOUT_MS = 120_000;

self.addEventListener('install', (e) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), INSTALL_TIMEOUT_MS);
  e.waitUntil((async () => {
    try {
      // cache: 'reload' skips the browser's HTTP cache. Without it, a host that lets browsers keep
      // files for a while (GitHub Pages: 10 minutes) can mix new and old files in one version.
      // Read each file in full as soon as it arrives. Holding responses unread until all have
      // arrived deadlocks: the unread large files keep the browser's few connections busy, so
      // the remaining requests never start.
      const files = await Promise.all(ASSETS.map(async (url) => {
        const res = await fetch(new Request(url, { cache: 'reload', signal: abort.signal }));
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return { url, body: await res.blob(), type: res.headers.get('Content-Type') || '' };
      }));
      for (const { url, body } of files) {
        if (STAMPED.includes(url) && !(await body.text()).includes(VERSION)) {
          throw new Error(`${url} on the server is not ${VERSION} yet`);
        }
      }
      const cache = await caches.open(VERSION);
      await Promise.all(files.map(({ url, body, type }) =>
        cache.put(url, new Response(body, { headers: { 'Content-Type': type } }))));
    } catch (err) {
      await caches.delete(VERSION); // don't leave a half-filled cache behind
      throw err;
    } finally {
      clearTimeout(timer);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
