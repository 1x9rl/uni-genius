const CACHE = 'uni-genius-v3-shell-3';
const CORE = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

async function precacheAppShell(cache) {
  const page = await fetch('/', { cache: 'reload' });
  if (!page.ok) throw new Error('Could not download the app shell');
  await cache.put('/', page.clone());
  await cache.put('/index.html', page.clone());

  const html = await page.text();
  const entryAssets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((url) => url.startsWith('/assets/') && /\.(?:js|css)$/.test(url));

  if (entryAssets.length) await cache.addAll([...new Set(entryAssets)]);

  // Vite's lazy chat renderer and its styles are referenced by the entry bundle,
  // not by index.html. Cache those too so the first offline chat can render.
  const dependencies = new Set();
  for (const asset of entryAssets) {
    if (!/\.js$/.test(asset)) continue;
    try {
      const response = await fetch(asset);
      if (!response.ok) continue;
      const source = await response.clone().text();
      await cache.put(asset, response);
      for (const match of source.matchAll(/(?:assets\/)[^"'\x60\s)]+?\.(?:js|css|woff2?|ttf|svg)/g)) {
        dependencies.add('/' + match[0].replace(/^\//, ''));
      }
    } catch {
      // Keep the core app available even if an optional chunk cannot be cached.
    }
  }

  for (const dependency of dependencies) {
    try {
      const response = await fetch(dependency);
      if (response.ok) await cache.put(dependency, response);
    } catch {
      // Optional fonts/chunks can be fetched later while online.
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(async (cache) => {
        await cache.addAll(CORE);
        await precacheAppShell(cache);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put('/index.html', copy));
          }
          return response;
        })
        .catch(async () => (await caches.match('/index.html')) || Response.error())
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }))
    );
    return;
  }

  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request))
  );
});
