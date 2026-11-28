'use strict';
/* My Language Coach — frontend only. Data in localStorage; no AI/voice/backend yet. */

const GOAL = 600; // 10 minutes in seconds
const RING = 2 * Math.PI * 100;
const KEY = 'mlc.sessions.v1';
const ACTIVE_KEY = 'mlc.active.v1';
const LANGS = {
  en: { name: 'English', full: 'English (US)',
    lines: ['Hi! How was your day today?', 'Tell me about something you enjoyed recently.',
      'What are your plans for the weekend?', 'Describe your favourite place in your city.',
      'If you could travel anywhere, where would you go?'] },
  lv: { name: 'Latviešu', full: 'Latvian',
    lines: ['Sveiki! Kā tev šodien klājas?', 'Pastāsti man par savu dienu.',
      'Ko tu plāno darīt nedēļas nogalē?', 'Kāds ir tavs mīļākais ēdiens?',
      'Kur tu vislabprātāk ceļotu?'] }
};
const FLAGS = {
  en: `<svg viewBox="0 0 190 100" preserveAspectRatio="none"><rect width="190" height="100" fill="#b22234"/>${
    [1,3,5,7,9,11].map(i => `<rect y="${i*100/13}" width="190" height="${100/13}" fill="#fff"/>`).join('')
  }<rect width="76" height="${700/13}" fill="#3c3b6e"/>${
    Array.from({length:5},(_,r)=>Array.from({length:6},(_,c)=>`<circle cx="${6.3+c*12.6}" cy="${5.4+r*10.8}" r="2.2" fill="#fff"/>`).join('')).join('')
  }</svg>`,
  lv: `<svg viewBox="0 0 20 10" preserveAspectRatio="none"><rect width="20" height="10" fill="#9e3039"/><rect y="4" width="20" height="2" fill="#fff"/></svg>`
};

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

/* ---------- storage ---------- */
function load() {
  try { const v = JSON.parse(localStorage.getItem(KEY)); if (Array.isArray(v)) return v; } catch {}
  const seeded = mockSessions(); save(seeded); return seeded;
}
function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {} }
function mockSessions() {
  // Mock history over the last ~3 weeks so the stats screen has content.
  const out = [], now = new Date();
  const plan = [[1,'en',642],[1,'lv',488],[2,'en',731],[4,'lv',603],[5,'en',415],[6,'lv',812],
                [8,'en',600],[9,'lv',356],[11,'en',905],[13,'lv',620],[15,'en',540],[18,'lv',700],[20,'en',610]];
  for (const [ago, lang, dur] of plan) {
    const d = new Date(now); d.setDate(d.getDate() - ago); d.setHours(19 + (ago % 3), (ago * 7) % 60, 0, 0);
    out.push({ id: 'm' + ago + lang, lang, start: d.getTime(), duration: dur, mock: true });
  }
  return out.sort((a, b) => b.start - a.start);
}
let sessions = load();

/* ---------- helpers ---------- */
const pad = n => String(n).padStart(2, '0');
const mmss = s => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
const hm = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h ${pad(m)}m` : `${m}m`; };
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const sum = (arr) => arr.reduce((a, s) => a + s.duration, 0);
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}
$$('[data-flag]').forEach(el => el.innerHTML = FLAGS[el.dataset.flag]);

/* ---------- navigation ---------- */
let current = 'home';
function go(id) {
  if (id === current) return;
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.go === id));
  $('#tabbar').classList.toggle('hide', id === 'conversation');
  current = id;
  if (id === 'home') renderHome();
  if (id === 'stats') renderStats();
  if (id !== 'conversation') history.replaceState(null, '', '#' + id);
  else history.pushState(null, '', '#conversation');
}
$$('.tab').forEach(t => t.addEventListener('click', () => go(t.dataset.go)));
$$('.lang-card').forEach(c => c.addEventListener('click', () => openConversation(c.dataset.lang)));
$('#conv-back').addEventListener('click', leaveConversation);
window.addEventListener('popstate', () => { if (current === 'conversation') leaveConversation(true); });

/* ---------- conversation ---------- */
let conv = { lang: 'en', running: false, start: 0, tick: null, mic: false, lineIdx: 0, lineTimer: null };

function openConversation(lang) {
  conv.lang = lang;
  $('#conv-flag').innerHTML = FLAGS[lang];
  $('#conv-name').textContent = LANGS[lang].full;
  if (!conv.running) resetConvUI();
  go('conversation');
}
function leaveConversation(fromPop) {
  if (conv.running) {
    if (fromPop === true) history.pushState(null, '', '#conversation');
    return askEnd();
  }
  if (fromPop !== true && location.hash === '#conversation') history.back();
  go('home');
}
function resetConvUI() {
  $('#timer').textContent = '10:00'; $('#timer').classList.remove('over');
  $('#timer-label').textContent = 'Session goal'; $('#timer-sub').textContent = '10 minute target';
  $('#ring-fg').style.strokeDashoffset = 0; $('#ring-fg').style.stroke = '';
  setStatus('Ready', '');
  $('#coach-line').innerHTML = 'Tap <b>Start Conversation</b> when you\'re ready.';
  $('#btn-start').classList.remove('hidden'); $('#btn-end').classList.add('hidden');
  $('#mic').disabled = true; setMic(false);
}
function setStatus(text, cls) { const p = $('#conv-status'); p.textContent = text; p.className = 'status-pill ' + cls; }

function startConversation(resumeStart) {
  conv.running = true;
  conv.start = resumeStart || Date.now();
  try { localStorage.setItem(ACTIVE_KEY, JSON.stringify({ lang: conv.lang, start: conv.start })); } catch {}
  $('#btn-start').classList.add('hidden'); $('#btn-end').classList.remove('hidden');
  $('#mic').disabled = false; setMic(true);
  update(); conv.tick = setInterval(update, 250);
  if (Live.enabled() && !resumeStart) beginLive();
  else if (Live.enabled()) { setMic(false); $('#coach-line').textContent = 'Session resumed — tap the microphone to reconnect.'; }
  else startMockLines();
  requestWakeLock();
}
function startMockLines() {
  clearInterval(conv.lineTimer);
  conv.lineIdx = 0; showLine();
  conv.lineTimer = setInterval(() => { if (conv.mic) showLine(); }, 9000);
}

/* ---------- Gemini Live (voice) ---------- */
async function beginLive() {
  if (!Live.getPass()) return askPassphrase();
  conv.live = 'connecting';
  $('#coach-line').textContent = 'Connecting to your coach…';
  try {
    await Live.start(conv.lang, {
      status: st => {
        conv.live = st;
        if (st === 'live') { $('#coach-line').textContent = conv.lang === 'lv' ? 'Sāc runāt — es klausos.' : 'Start speaking — I\'m listening.'; setMic(conv.mic); }
        if (st === 'reconnecting') $('#mic-hint').textContent = 'Reconnecting…';
      },
      coach: text => { $('#coach-line').textContent = text; },
      speaking: on => $('#waves').classList.toggle('on', on || conv.mic),
      error: msg => liveFailed(msg)
    });
    Live.setMuted(!conv.mic);
  } catch (e) { liveFailed(e); }
}
function liveFailed(e) {
  conv.live = null;
  if (!conv.running) return;
  const code = e?.status || '';
  const msg = code === 401 ? 'Wrong passphrase' : code === 429 ? 'Free-tier limit reached — try later'
    : e?.name === 'NotAllowedError' ? 'Microphone permission denied' : 'Voice coach unavailable';
  if (code === 401) Live.setPass('');
  toast(msg + ' · timer keeps running');
  setMic(false);
  $('#coach-line').textContent = 'Voice coach offline. Tap the microphone to retry.';
}
function askPassphrase() {
  $('#pass-input').value = '';
  $('#pass').classList.remove('hidden');
  setTimeout(() => $('#pass-input').focus(), 50);
}
$('#pass-save').addEventListener('click', () => {
  const v = $('#pass-input').value.trim();
  if (!v) return;
  Live.setPass(v); $('#pass').classList.add('hidden');
  if (conv.running) beginLive();
});
$('#pass-cancel').addEventListener('click', () => {
  $('#pass').classList.add('hidden');
  if (conv.running) { toast('Demo mode · no voice coach'); startMockLines(); }
});

function elapsed() { return Math.floor((Date.now() - conv.start) / 1000); }
function update() {
  const e = elapsed(), timer = $('#timer');
  if (e < GOAL) {
    timer.textContent = mmss(GOAL - e);
    $('#ring-fg').style.strokeDashoffset = (RING * e / GOAL).toFixed(2);
    $('#timer-sub').textContent = `${mmss(e)} spoken`;
    setStatus(conv.mic ? 'Live' : 'Paused', conv.mic ? 'live' : '');
  } else {
    if (!timer.classList.contains('over')) { timer.classList.add('over'); toast('10 minutes reached — keep going!'); navigator.vibrate?.(60); }
    timer.textContent = '+' + mmss(e - GOAL);
    $('#timer-label').textContent = 'Goal complete';
    $('#timer-sub').textContent = `${mmss(e)} total`;
    $('#ring-fg').style.strokeDashoffset = 0; // full ring once goal is reached
    $('#ring-fg').style.stroke = 'var(--gold)';
    setStatus('Overtime', 'over');
  }
}
function showLine() {
  const lines = LANGS[conv.lang].lines, el = $('#coach-line');
  el.style.opacity = 0;
  setTimeout(() => { el.textContent = lines[conv.lineIdx++ % lines.length]; el.style.opacity = 1; }, 250);
}
function setMic(on) {
  conv.mic = on;
  if (Live.active()) Live.setMuted(!on);
  $('#mic').classList.toggle('on', on); $('#waves').classList.toggle('on', on);
  $('#mic-hint').textContent = !conv.running ? 'Microphone off' : on ? 'Listening… tap to mute' : 'Muted — tap to speak';
}
$('#mic').addEventListener('click', () => {
  if (!conv.running) return;
  if (Live.enabled() && !Live.active() && !conv.lineTimer) { setMic(true); beginLive(); return; }
  setMic(!conv.mic); update();
});
$('#btn-start').addEventListener('click', () => startConversation());
$('#btn-end').addEventListener('click', askEnd);

function askEnd() {
  const e = elapsed();
  $('#confirm-text').textContent = e < 60
    ? `Only ${e}s so far. Sessions under a minute aren't saved.`
    : `You've spoken for ${mmss(e)}. This session will be saved to your statistics.`;
  $('#confirm').classList.remove('hidden');
}
$('#confirm-no').addEventListener('click', () => $('#confirm').classList.add('hidden'));
$('#confirm').addEventListener('click', e => { if (e.target.id === 'confirm') $('#confirm').classList.add('hidden'); });
$('#confirm-yes').addEventListener('click', () => {
  $('#confirm').classList.add('hidden');
  const dur = elapsed();
  clearInterval(conv.tick); clearInterval(conv.lineTimer); conv.lineTimer = null;
  Live.stop(); conv.live = null;
  conv.running = false;
  try { localStorage.removeItem(ACTIVE_KEY); } catch {}
  releaseWakeLock();
  if (dur >= 60) {
    sessions.unshift({ id: 's' + conv.start, lang: conv.lang, start: conv.start, duration: dur });
    save(sessions); toast(`Saved · ${mmss(dur)} of ${LANGS[conv.lang].name}`);
  } else toast('Session too short — not saved');
  resetConvUI();
  if (location.hash === '#conversation') history.back();
  go('home');
});

/* Keep screen awake during a session */
let wakeLock = null;
async function requestWakeLock() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {} }
function releaseWakeLock() { wakeLock?.release?.(); wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && conv.running) { requestWakeLock(); update(); } });

/* ---------- home ---------- */
function streak() {
  const days = new Set(sessions.map(s => dayKey(s.start)));
  const d = new Date(); let n = 0;
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function renderHome() {
  const h = new Date().getHours();
  $('#greeting').textContent = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const today = dayKey(Date.now());
  for (const l of ['en', 'lv']) {
    const m = Math.round(sum(sessions.filter(s => s.lang === l && dayKey(s.start) === today)) / 60);
    $(`[data-today="${l}"]`).textContent = `${m} min today`;
  }
  $('#sum-streak').textContent = streak();
  $('#sum-week').textContent = Math.round(sum(sessions.filter(s => s.start > Date.now() - 7 * 864e5)) / 60);
  $('#sum-count').textContent = sessions.length;
}

/* ---------- stats ---------- */
let calMonth = new Date(); calMonth.setDate(1);
$('#cal-prev').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); });
$('#cal-next').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); });

function renderStats() {
  const en = sum(sessions.filter(s => s.lang === 'en')), lv = sum(sessions.filter(s => s.lang === 'lv')), tot = en + lv;
  $('#st-total').textContent = hm(tot);
  $('#st-en').textContent = hm(en); $('#st-lv').textContent = hm(lv);
  $('#bar-en').style.width = tot ? (en / tot * 100) + '%' : '0';
  $('#bar-lv').style.width = tot ? (lv / tot * 100) + '%' : '0';
  renderCalendar(); renderHistory();
}
function renderCalendar() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  $('#cal-title').textContent = calMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const byDay = {};
  sessions.forEach(s => { (byDay[dayKey(s.start)] ||= new Set()).add(s.lang); });
  const offset = (new Date(y, m, 1).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
  const today = dayKey(Date.now());
  let html = '<span></span>'.repeat(offset);
  for (let d = 1; d <= days; d++) {
    const k = `${y}-${m}-${d}`, langs = byDay[k];
    const dots = langs ? [...langs].sort().map(l => `<i class="d ${l}"></i>`).join('') : '';
    html += `<div class="day${langs ? ' has' : ''}${k === today ? ' today' : ''}">${d}<span class="dots">${dots}</span></div>`;
  }
  $('#cal-grid').innerHTML = html;
}
function renderHistory() {
  const ul = $('#history');
  if (!sessions.length) { ul.innerHTML = '<li class="empty">No sessions yet</li>'; return; }
  ul.innerHTML = sessions.map(s => {
    const d = new Date(s.start);
    const when = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' +
      d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return `<li><span class="flag sm">${FLAGS[s.lang]}</span>
      <span class="h-main"><b>${LANGS[s.lang].name}${s.duration >= GOAL ? '<span class="goal">Goal</span>' : ''}</b><small>${when}</small></span>
      <span class="h-dur">${mmss(s.duration)}</span></li>`;
  }).join('');
}

/* ---------- boot ---------- */
renderHome();
history.replaceState(null, '', '#home');
try {
  const a = JSON.parse(localStorage.getItem(ACTIVE_KEY));
  if (a && LANGS[a.lang]) { openConversation(a.lang); startConversation(a.start); toast('Session resumed'); }
} catch {}
// preview copy: no service worker
