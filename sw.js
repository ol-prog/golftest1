// Offline support. The app shell is precached on install; the 28 MB of body
// tracking model and wasm is deliberately NOT, because nobody wants that
// arriving unannounced over mobile data. It is fetched by the "Download for
// offline use" button into MODEL_CACHE and served from there afterwards.

const SHELL_CACHE = 'swinglab-shell-v1';
const MODEL_CACHE = 'swinglab-models-v1';

const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/util.js',
  'js/store.js',
  'js/motion.js',
  'js/frames.js',
  'js/events.js',
  'js/club.js',
  'js/ball.js',
  'js/pose.js',
  'js/analyse.js',
  'js/coach.js',
  'js/overlay.js',
  'js/capture.js',
  'js/tracer.js',
  'js/profile.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
      // A single missing file must not leave the app with no worker at all.
      .catch((err) => console.warn('Shell precache incomplete', err)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== MODEL_CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Model and wasm: cache first, and remember anything fetched so the app works
  // offline even if the golfer never pressed the download button.
  if (url.pathname.includes('/vendor/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(MODEL_CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })),
    );
    return;
  }

  // Everything else: try the network so updates land, fall back to the cache.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('index.html'))),
  );
});
