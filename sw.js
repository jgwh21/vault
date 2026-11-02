// Caches the app's own files so Vault opens with no internet connection.
// Bump VERSION whenever any file changes so installed copies pick up the update
// (run `python build-upload.py --bump`, which also updates the stamps below).
const VERSION = 'vault-v6';
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

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // cache: 'reload' skips the browser's HTTP cache. Without it, a host that lets browsers keep
    // files for a while (GitHub Pages: 10 minutes) can mix new and old files in one version.
    const responses = await Promise.all(ASSETS.map(async (url) => {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return [url, res];
    }));
    for (const [url, res] of responses) {
      if (STAMPED.includes(url) && !(await res.clone().text()).includes(VERSION)) {
        throw new Error(`${url} on the server is not ${VERSION} yet`);
      }
    }
    const cache = await caches.open(VERSION);
    await Promise.all(responses.map(([url, res]) => cache.put(url, res)));
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
