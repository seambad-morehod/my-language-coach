# My Language Coach

Mobile-first PWA for spoken English & Latvian practice, tuned for Samsung Galaxy S26 Ultra (dark only).

## Structure
- `index.html` – screens: Home, Conversation, Statistics; bottom tab bar
- `styles.css` – premium dark theme
- `app.js` – navigation, timer, mock coach prompts, localStorage stats (seeded with mock history)
- `manifest.webmanifest`, `sw.js`, `icons/` – PWA install + offline cache

## Run
```
python3 -m http.server 8080
```
Install on Android: serve over HTTPS (e.g. GitHub Pages / Netlify), open in Chrome/Samsung Internet → "Add to Home screen / Install app".

Not yet implemented (by design): AI, speech APIs, backend.
