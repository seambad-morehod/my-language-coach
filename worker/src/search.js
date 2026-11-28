// Web search for the Gemini Live `web_search` function (free sources only).
//   weather  → Open-Meteo (free, no key, does not use Tavily credits)
//   news / general → Tavily Search API (free plan: 1,000 credits/month, no card; "basic" search = 1 credit)
// Free-limit protection: checks Tavily's usage endpoint before each search and stops well below the plan
// limit, enforces a daily budget, and caches identical queries. Without a card Tavily cannot charge anyway.

const TAVILY_SEARCH = 'https://api.tavily.com/search';
const TAVILY_USAGE = 'https://api.tavily.com/usage';
const SAFETY_MARGIN = 50;        // stop at limit − 50 credits
const DAILY_BUDGET = 40;         // max Tavily searches per UTC day (≈1,000/month spread out)
const CACHE_TTL = 1800;          // seconds; identical queries within 30 min reuse the result

// Exposed to Gemini in the Live session setup.
export const SEARCH_TOOL = {
  functionDeclarations: [{
    name: 'web_search',
    description: 'Look up current or real-time information on the internet: weather, news, current events, ' +
      'prices, opening hours, recent developments, facts about specific places. Do not use for general conversation ' +
      'or for things you already know reliably.',
    behavior: 'NON_BLOCKING',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'A concise search query, ideally in the language the user is speaking.' },
        topic: { type: 'STRING', enum: ['weather', 'news', 'general'], description: 'weather = weather/forecast; news = recent events; general = anything else.' },
        location: { type: 'STRING', description: 'City or place name for weather questions, e.g. "Riga".' }
      },
      required: ['query', 'topic']
    }
  }]
};

export const SEARCH_RULE =
  'INTERNET SEARCH: You can call web_search for current or changing information you cannot know reliably — weather, ' +
  'news, current events, prices, schedules, opening hours, recent developments, details about a specific place. For ' +
  'everything else, answer from your own knowledge without searching. Do not say that you are searching or about to ' +
  'check; call the tool silently and, when the result arrives, give the answer directly and briefly in the conversation ' +
  'language, as part of the normal conversation. Mention a source only if the user asks. If the search fails or the ' +
  'daily limit is reached, say briefly that you couldn\'t check the latest information and answer from what you know, ' +
  'noting it may be out of date. Never suggest searching for something else.';

export async function webSearch(args, lang, env, ctx) {
  const query = String(args?.query || '').trim().slice(0, 300);
  const topic = ['weather', 'news', 'general'].includes(args?.topic) ? args.topic : 'general';
  if (!query) return { ok: false, error: 'empty_query' };
  if (topic === 'weather') {
    const w = await weather(args.location || query, lang).catch(() => null);
    if (w) return w;          // fall through to Tavily only if the place could not be found
  }
  return tavily(query, topic, lang, env, ctx);
}

/* ---------- Open-Meteo ---------- */
const WMO = { 0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog', 51: 'light drizzle',
  53: 'drizzle', 55: 'dense drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers',
  81: 'showers', 82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail' };

async function weather(place, lang) {
  const name = String(place).replace(/\b(weather|forecast|in|today|now|tomorrow|laiks|prognoze|šodien|rīt|tagad)\b/gi, ' ').replace(/\s+/g, ' ').trim() || 'Riga';
  const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=${lang === 'lv' ? 'lv' : 'en'}&name=${encodeURIComponent(name)}`)).json();
  const p = g?.results?.[0]; if (!p) return null;
  const f = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&timezone=auto&forecast_days=3` +
    '&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,relative_humidity_2m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&wind_speed_unit=ms')).json();
  const c = f.current, d = f.daily;
  const days = d.time.map((t, i) => `${t}: ${WMO[d.weather_code[i]] || 'code ' + d.weather_code[i]}, ${Math.round(d.temperature_2m_min[i])}…${Math.round(d.temperature_2m_max[i])}°C, precipitation chance ${d.precipitation_probability_max[i]}%`);
  return { ok: true, source: 'Open-Meteo',
    result: `Weather for ${p.name}${p.country ? ', ' + p.country : ''} (local time ${c.time}): now ${Math.round(c.temperature_2m)}°C ` +
      `(feels like ${Math.round(c.apparent_temperature)}°C), ${WMO[c.weather_code] || 'code ' + c.weather_code}, wind ${Math.round(c.wind_speed_10m)} m/s, ` +
      `humidity ${c.relative_humidity_2m}%, precipitation ${c.precipitation} mm. Forecast: ${days.join('; ')}.` };
}

/* ---------- Tavily ---------- */
async function tavily(query, topic, lang, env, ctx) {
  if (!env.TAVILY_API_KEY) return { ok: false, error: 'search_not_configured' };
  const cache = caches.default;
  const key = new Request(`https://cache.internal/tavily?t=${topic}&l=${lang}&q=${encodeURIComponent(query.toLowerCase())}`);
  const hit = await cache.match(key);
  if (hit) return { ...(await hit.json()), cached: true };

  // Daily budget (per UTC day; counter kept in the edge cache — best effort, the hard limit is below).
  const dayKey = new Request(`https://cache.internal/tavily-day/${new Date().toISOString().slice(0, 10)}`);
  const used = Number(await (await cache.match(dayKey))?.text() || 0);
  if (used >= DAILY_BUDGET) return { ok: false, error: 'daily_limit_reached' };

  // Hard guard: ask Tavily how many credits are used in this plan period (this call costs no credits).
  const u = await fetch(TAVILY_USAGE, { headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}` } }).catch(() => null);
  if (!u || !u.ok) return { ok: false, error: 'usage_check_failed' };   // fail closed: no check, no search
  const usage = await u.json();
  const usedCredits = Number(usage?.key?.usage ?? usage?.account?.plan_usage ?? NaN);
  const limit = Number(usage?.key?.limit ?? usage?.account?.plan_limit ?? NaN);
  if (!Number.isFinite(usedCredits) || !Number.isFinite(limit) || usedCredits >= limit - SAFETY_MARGIN)
    return { ok: false, error: 'monthly_limit_reached' };

  const r = await fetch(TAVILY_SEARCH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query, topic: topic === 'news' ? 'news' : 'general', search_depth: 'basic', max_results: 5,
      include_answer: 'basic', ...(topic === 'news' ? { time_range: 'week' } : {}) })
  });
  ctx?.waitUntil?.(cache.put(dayKey, new Response(String(used + 1), { headers: { 'Cache-Control': 'max-age=90000' } })));
  if (!r.ok) return { ok: false, error: `search_failed_${r.status}` };
  const d = await r.json();
  const out = { ok: true, source: 'Tavily',
    result: [d.answer ? `Summary: ${d.answer}` : '',
      ...(d.results || []).slice(0, 5).map((x, i) => `[${i + 1}] ${x.title} (${hostOf(x.url)}${x.published_date ? ', ' + x.published_date : ''}): ${String(x.content || '').replace(/\s+/g, ' ').slice(0, 450)}`)
    ].filter(Boolean).join('\n'),
    credits: { used: usedCredits + 1, limit } };
  ctx?.waitUntil?.(cache.put(key, new Response(JSON.stringify(out), { headers: { 'Cache-Control': `max-age=${CACHE_TTL}` } })));
  return out;
}
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
