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

## License
This project is made available under **your choice** of the following licenses:

- MIT License
- BSD 3-Clause License
- Creative Commons CC0 1.0 Universal

You may select whichever license best suits your needs. See the `LICENSE` file for
the full text of each option.
