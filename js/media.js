// Thumbnails and document rendering. Runs entirely on the device.

const THUMB_SIZE = 360;

const once = (el, event, ms = 8000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  el.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
  el.addEventListener('error', () => { clearTimeout(timer); reject(new Error('media error')); }, { once: true });
});

function drawThumb(source, w, h) {
  if (!w || !h) return null;
  const scale = Math.min(1, THUMB_SIZE / Math.min(w, h)); // short side = THUMB_SIZE; tiles crop to square
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75));
}

async function imageThumb(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return await drawThumb(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function videoThumb(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  try {
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    await once(video, 'loadedmetadata');
    video.currentTime = Math.min(1, (video.duration || 0) / 3);
    await once(video, 'seeked');
    return await drawThumb(video, video.videoWidth, video.videoHeight);
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** Best-effort thumbnail; returns null when the format can't be previewed on this device. */
export async function makeThumb(file, kind) {
  try {
    if (kind === 'image') return await imageThumb(file);
    if (kind === 'video') return await videoThumb(file);
  } catch {
    // e.g. HEIC on Windows, or a codec this browser can't decode
  }
  return null;
}

// ---- PDF (pdf.js, bundled locally in /vendor so it works offline) ----

let pdfjs;
function loadPdfJs() {
  pdfjs ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/pdfjs/pdf.min.js';
    const fail = () => { pdfjs = null; s.remove(); reject(new Error('Could not load the PDF viewer')); };
    s.onload = () => {
      if (!window.pdfjsLib) return fail(); // e.g. a truncated download
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    s.onerror = fail;
    document.head.append(s);
  });
  return pdfjs;
}

/**
 * Render a PDF into `container`, one canvas per page. Pages are drawn only when
 * near the screen and released when far away, to stay within iOS canvas memory limits.
 */
export async function renderPdf(blob, container) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
  const width = Math.min(container.clientWidth - 16, 1000);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const first = (await doc.getPage(1)).getViewport({ scale: 1 });

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page';
    canvas.dataset.page = n;
    canvas.style.width = `${width}px`;
    canvas.style.aspectRatio = `${first.width} / ${first.height}`;
    container.append(canvas);
    pages.push(canvas);
  }

  const rendering = new Map();
  const observer = new IntersectionObserver((entries) => {
    for (const { target: canvas, isIntersecting } of entries) {
      const n = Number(canvas.dataset.page);
      if (isIntersecting && !rendering.has(n)) {
        rendering.set(n, (async () => {
          const page = await doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * dpr });
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.aspectRatio = `${base.width} / ${base.height}`;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        })().catch(() => {}));
      } else if (!isIntersecting && rendering.has(n)) {
        rendering.get(n).then(() => { canvas.width = 0; canvas.height = 0; });
        rendering.delete(n);
      }
    }
  }, { root: container, rootMargin: '150% 0px' });
  pages.forEach((p) => observer.observe(p));

  return {
    pageCount: doc.numPages,
    destroy() { observer.disconnect(); doc.destroy(); },
  };
}
