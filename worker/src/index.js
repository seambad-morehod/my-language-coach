// My Language Coach — token service (Cloudflare Worker).
// Holds GEMINI_API_KEY and hands the browser a short-lived, single-use Gemini Live ephemeral token
// that is locked to one model, one language and one configuration.
// Docs: https://ai.google.dev/gemini-api/docs/ephemeral-tokens , https://ai.google.dev/api/live
import { LANGUAGES } from './languages.js';

const TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
const SESSION_HOURS = 2;      // token may carry an ongoing session (with resumption) for 2 h
const START_WINDOW_MS = 60e3; // a new session must be started within 60 s
// Technical rule for the search tool (not the teacher instructions, which are configured separately).
const SEARCH_RULE = 'Use Google Search only when the user asks about recent or current information you cannot know reliably ' +
  '(news, current events, today\'s or yesterday\'s facts, live prices, weather, schedules). For everything else, answer directly ' +
  'without searching. After searching, answer briefly in the same language and voice as the rest of the conversation.';

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin) ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Access-Key',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    } : {};
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }
    });

    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: allowed.includes(origin) ? 204 : 403, headers: cors });
    if (url.pathname === '/health') return json({ ok: true, model: env.GEMINI_MODEL });
    if (url.pathname !== '/token' || req.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (!allowed.includes(origin)) return json({ error: 'origin_not_allowed' }, 403);
    if (!env.GEMINI_API_KEY || !env.ACCESS_PASSPHRASE) return json({ error: 'server_not_configured' }, 500);
    if (!(await safeEqual(req.headers.get('X-Access-Key') || '', env.ACCESS_PASSPHRASE))) return json({ error: 'unauthorized' }, 401);

    let body; try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
    const lang = LANGUAGES[body?.lang];
    if (!lang) return json({ error: 'unknown_language' }, 400);

    const model = `models/${env.GEMINI_MODEL}`;
    const now = Date.now();
    const setup = {
      model,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: lang.voice } } }
      },
      systemInstruction: { parts: [{ text: lang.instruction + '\n\n' + SEARCH_RULE }] },
      // Built-in Google Search inside the same Live session (free tier: 500 requests/day, no billing).
      tools: [{ googleSearch: {} }],
      contextWindowCompression: { slidingWindow: {} },      // lifts the 15-min audio session limit
      inputAudioTranscription: { languageCodes: [lang.code] },
      outputAudioTranscription: { languageCodes: [lang.code] }
    };
    const token = {
      uses: 1,
      expireTime: new Date(now + SESSION_HOURS * 3600e3).toISOString(),
      newSessionExpireTime: new Date(now + START_WINDOW_MS).toISOString(),
      bidiGenerateContentSetup: setup,
      // Locked fields: these come from the token and override anything the client sends.
      // sessionResumption is deliberately NOT locked so the client can pass its resume handle.
      fieldMask: Object.keys(setup).join(',')
    };

    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(token)
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 500); // never contains the key
      console.log('auth_tokens error', r.status, detail);
      return json({ error: 'upstream_error', status: r.status, detail }, r.status === 429 ? 429 : 502);
    }
    const t = await r.json();
    return json({ token: t.name, model, lang: body.lang, languageCode: lang.code, expiresAt: token.expireTime });
  }
};

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
