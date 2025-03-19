// sw.js - Service Worker for caching the album player resources

const CACHE_NAME = 'base3-album-cache-v3';
const urlsToCache = [
    '/',
    'index.html',
    '/images/Base3Logo.jpg',
    '/music/Lead_with_Your_Hips.m4a',
    '/music/Midnight_Attitude.m4a',
    '/music/Full_Capacity.m4a',
    '/music/Deep_Sleep.m4a',
    '/music/Level_9.m4a',
    '/music/windy.m4a',
    '/music/T-Rex_T-Rex.m4a',
    '/music/Walking_on_the_C.m4a',
    '/music/Won_2_1.m4a',
    '/music/Lead_with_Your_Hips.wav',
    '/music/Midnight_Attitude.wav',
    '/music/Full_Capacity.wav',
    '/music/Deep_Sleep.wav',
    '/music/Level_9.wav',
    '/music/windy.wav',
    '/music/T-Rex_T-Rex.wav',
    '/music/Walking_on_the_C.wav',
    '/music/Won_2_1.wav',
    // Add other assets and audio files here as needed
];

self.addEventListener('install', (event) => {
    // Perform install steps
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Opened cache');
                return Promise.all(
                    urlsToCache.map(url => 
                        cache.add(url)
                            .then(() => console.log(`Successfully cached ${url}`))
                            .catch(error => console.error(`Failed to cache ${url}:`, error))
                    )
                );
            })
    );
});

self.addEventListener('fetch', (event) => {
    const requestURL = new URL(event.request.url);

    if (requestURL.pathname.startsWith('/music/')) {
        event.respondWith(
            caches.open(CACHE_NAME).then((cache) => {
                return cache.match(event.request).then((cachedResponse) => {
                    if (cachedResponse) {
                        console.log(`Serving ${event.request.url} from cache`);
                        return cachedResponse;
                    }
                    console.log(`Fetching ${event.request.url} from network`);

                    // Clone the request and remove Range headers
                    const modifiedRequest = new Request(event.request, {
                        headers: new Headers(event.request.headers)
                    });
                    modifiedRequest.headers.delete('Range');

                    return fetch(modifiedRequest).then((networkResponse) => {
                        if (!networkResponse || networkResponse.status !== 200) {
                            throw new Error('Failed to fetch or non-200 response');
                        }
                        cache.put(event.request, networkResponse.clone());
                        return networkResponse;
                    }).catch((error) => {
                        console.error(`Fetch failed for ${event.request.url}:`, error);
                        return new Response('Offline - song not available in cache', {
                            status: 408,
                            statusText: 'Network and cache failed',
                        });
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
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (!cacheWhitelist.includes(cacheName)) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

