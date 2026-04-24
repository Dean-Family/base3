# Base 3 Album Player

A static web application for listening to the album **Base 3** online.

## Usage
Open `index.html` in a modern browser to play tracks. A service worker stores audio
files in IndexedDB for offline playback and also caches the app shell so the player
loads while offline. The app includes a web app manifest and theme color so it can be
installed like a Progressive Web App.

## Debugging offline support
The player now exposes a **Debug Tools** section in the UI that shows your current
online status and lists everything stored in the service worker cache. You can
refresh the list or clear all caches directly from the page to help troubleshoot
offline behaviour.

## Offline regression checklist
Use this quick smoke test after service worker or playback changes:

1. Open the site while online and wait for the service worker to activate.
2. Save at least one track with **Save for offline**.
3. Disable network (DevTools → Offline) and refresh.
4. Confirm the app shell still loads from cache.
5. Play the saved track and seek within it.
6. Reload once more while still offline and verify playback state resumes.

The service worker also includes a navigation fallback that first tries a cached
navigation match with query strings ignored, then falls back to `/index.html` (or
`/`). This keeps direct offline reloads working even when the requested URL shape
does not exactly match a cached key.

## Automated Testing
This project includes a robust Playwright test suite for verifying offline
persistence, Service Worker lifecycle, and UI synchronization.

See [TESTING.md](./TESTING.md) for architecture details and core mandates.

## License
This project is made available under **your choice** of the following licenses:

- MIT License
- BSD 3-Clause License
- Creative Commons CC0 1.0 Universal

You may select whichever license best suits your needs. See the `LICENSE` file for
the full text of each option.
