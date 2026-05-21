const CACHE_NAME = 'splitaway-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&family=Noto+Serif:ital,wght@0,700;0,900;1,700&display=swap',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdnjs.cloudflare.com/ajax/libs/vanilla-tilt/1.8.1/vanilla-tilt.min.js'
];

// Install event: cache core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(ASSETS_TO_CACHE);
      })
  );
});

// Activate event: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Fetch event: Network-first strategy for dynamic content, fallback to cache
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  
  // Exclude Supabase API requests from service worker caching
  if (event.request.url.includes('supabase.co')) return;

  event.respondWith(
    fetch(event.request)
      .then(networkResponse => {
        // If we got a valid response, clone it and cache it
        if (networkResponse && networkResponse.status === 200 && (networkResponse.type === 'basic' || networkResponse.type === 'cors')) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // If network fails (offline), fall back to cache
        return caches.match(event.request);
      })
  );
});
