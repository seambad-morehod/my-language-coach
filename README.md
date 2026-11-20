# My Language Coach

Mobile-first PWA for spoken English & Latvian practice, tuned for Samsung Galaxy S26 Ultra (dark only).
Live: https://seambad-morehod.github.io/my-language-coach/

## Architecture
```
PWA (GitHub Pages)  ──POST /token──►  Cloudflare Worker (holds GEMINI_API_KEY)
       ▲                                   └─► Gemini API: create ephemeral token
       │◄──────── short-lived token ───────┘     (locked to model + language + config)
       └── WebSocket (audio 16 kHz in / 24 kHz out) ──► Gemini Live (gemini-3.8-live)
```
- `index.html`, `styles.css`, `app.js` – UI, timer, statistics (unchanged behaviour)
- `live.js` – Gemini Live client: mic capture, WebSocket, playback, session resumption
- `config.js` – public config: `backendUrl` (no secrets). Empty = demo mode with mock prompts
- `worker/` – Cloudflare Worker token service; per-language settings in `worker/src/languages.js`
- `manifest.webmanifest`, `sw.js`, `icons/` – PWA install + offline

The API key never reaches the browser or GitHub. The Worker also requires `ACCESS_PASSPHRASE`
(entered once in the app, stored only on the phone) and only answers the allowed origins.

## Deploy the backend (one time)
Requires Node.js 18+ on your computer and a free Cloudflare account.

1. Create a Gemini API key at https://aistudio.google.com/apikey
2. In the `worker/` folder:
   ```bash
   npm install
   npx wrangler login
   npx wrangler secret put GEMINI_API_KEY      # paste the key at the hidden prompt
   npx wrangler secret put ACCESS_PASSPHRASE   # choose a long random passphrase
   npx wrangler deploy
   ```
3. Copy the printed URL (`https://my-language-coach-api.<subdomain>.workers.dev`) into `config.js` → `backendUrl`, commit and push.
4. Open the app, start a conversation, enter the passphrase once.

Check: `https://<worker-url>/health` returns `{"ok":true,"model":"gemini-3.8-live"}`.

Local testing: copy `worker/.dev.vars.example` to `worker/.dev.vars` (git-ignored), then `npm run dev`.

## Key security
- Never put the key in `config.js`, any frontend file, `wrangler.toml`, or a commit.
- `wrangler secret put` stores it encrypted in Cloudflare; it is not shown again.
- Rotate: create a new key in AI Studio, run `wrangler secret put GEMINI_API_KEY` again, delete the old key.
- If the key ever leaks, delete it in AI Studio immediately.

## Gemini free tier — verified limitations (Nov 2026)
- Model `gemini-3.8-live` (stable, free tier). Change via `GEMINI_MODEL` in `worker/wrangler.toml`.
- Free-tier data **is used to improve Google's products** (includes your voice).
- Live rate limits are per project; see AI Studio.
- Connections reset ~every 10 min; handled by session resumption. Context-window compression lifts the 15-min audio limit.
- Ephemeral tokens are a preview feature.

## Not yet implemented
Final teacher instructions (placeholders in `worker/src/languages.js`).
