// sw.js - Service Worker for caching the album player resources

const CACHE_NAME = 'base3-album-cache-v5';
const urlsToCache = [
    '/',
    '/index.html',
    '/images/Base3Logo.jpg'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('Opened cache');
            return Promise.all(
                urlsToCache.map((url) =>
                    cache
                        .add(url)
                        .then(() => console.log(`Successfully cached ${url}`))
                        .catch((error) => console.error(`Failed to cache ${url}:`, error))
                )
            );
        })
    );
});

self.addEventListener('fetch', (event) => {
    const requestURL = new URL(event.request.url);

    if (requestURL.pathname.startsWith('/music/')) {
        // Audio requests sometimes include a Range header for streaming.
        // These are best handled directly by the network to avoid issues
        // with partial content and cache lookups.
        if (event.request.headers.has('range')) {
            event.respondWith(fetch(event.request));
            return;
        }

        event.respondWith(
            caches.match(event.request).then((cachedResponse) => {
                if (cachedResponse) {
                    console.log(`Serving ${event.request.url} from cache`);
                    return cachedResponse;
                }
                console.log(`Fetching ${event.request.url} from network`);
                return fetch(event.request).catch((error) => {
                    console.error(`Fetch failed for ${event.request.url}:`, error);
                    return new Response('Offline - song not available in cache', {
                        status: 408,
                        statusText: 'Network and cache failed',
                    });
                });
            })
        );
    } else {
        // Handle non-audio requests
        event.respondWith(
            caches.match(event.request).then((response) => {
                return response || fetch(event.request);
            })
        );
    }
});

self.addEventListener('activate', (event) => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches
            .keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (!cacheWhitelist.includes(cacheName)) {
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', (event) => {
    const { action, url } = event.data || {};
    if (!url) return;

    const respond = (status) => {
        if (event.source) {
            event.source.postMessage({ status, url });
        }
    };

    if (action === 'save') {
        event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => {
                return fetch(url)
                    .then((response) => {
                        if (!response.ok) {
                            throw new Error(`Network response was not ok for ${url}`);
                        }
                        return cache.put(url, response.clone());
                    })
                    .then(() => {
                        console.log(`Cached ${url}`);
                        respond('saved');
                    })
                    .catch((error) => {
                        console.error(`Failed to cache ${url}:`, error);
                        respond('error');
                    });
            })
        );
    } else if (action === 'remove') {
        event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => {
                return cache.delete(url).then((deleted) => {
                    console.log(deleted ? `Removed ${url} from cache` : `${url} not found in cache`);
                    respond('removed');
                });
            })
        );
    } else if (action === 'check') {
        event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => {
                return cache.match(url).then((response) => {
                    respond(response ? 'saved' : 'removed');
                });
            })
        );
    }
});

