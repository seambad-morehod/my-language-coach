'use strict';
/* Test 2 — Gemini Live through Android "Media" volume.
   Standalone test client (does NOT use or modify the app's live.js):
   - mic always open, echoCancellation:false, noiseSuppression:true, autoGainControl:true
   - Gemini voice via Web Audio (24 kHz)
   - while Gemini is speaking (+ a short pause) mic audio is NOT sent to Gemini (half-duplex gate)
   - barge-in: if the mic is clearly louder than the expected echo, playback stops and sending resumes
   Uses the existing Worker (/token, /search) unchanged. */
const BACKEND = 'https://my-language-coach-api.seambad.workers.dev';
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const CHUNK = 800;            // 50 ms @ 16 kHz
const $ = id => document.getElementById(id);

const WORKLET = `
class Rec extends AudioWorkletProcessor {
  constructor(){ super(); this.ratio = sampleRate/16000; this.buf = new Int16Array(${CHUNK}); this.n = 0; this.pos = 0; this.sq = 0; }
  process(inputs){
    const ch = inputs[0][0]; if (!ch) return true;
    for (; this.pos < ch.length; this.pos += this.ratio) {
      const s = Math.max(-1, Math.min(1, ch[Math.floor(this.pos)]));
      this.sq += s*s; this.buf[this.n++] = s < 0 ? s*0x8000 : s*0x7fff;
      if (this.n === ${CHUNK}) { this.port.postMessage({ pcm: this.buf.buffer, rms: Math.sqrt(this.sq/${CHUNK}) }, [this.buf.buffer]); this.buf = new Int16Array(${CHUNK}); this.n = 0; this.sq = 0; }
    }
    this.pos -= ch.length; return true;
  }
}
registerProcessor('mlc-test-rec', Rec);`;

let S = null;
const M = { turns: 0, barges: 0, falseBarge: 0, btn: 0, echo: 0, lat: [], resume: [], micSettings: '—' };
const answers = {};

function getPass() {
  try { const p = localStorage.getItem('mlc.passphrase'); if (p) return p; } catch {}
  return $('pass').value.trim();
}
try { if (!localStorage.getItem('mlc.passphrase')) $('passRow').style.display = 'flex'; } catch { $('passRow').style.display = 'flex'; }

const b64 = buf => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = str => { const b = atob(str), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
const status = t => { $('st').textContent = t; };
function log(cls, text) { const p = document.createElement('p'); p.className = cls; p.textContent = text; $('log').prepend(p); }

async function start() {
  if (S) return;
  const lang = $('lang').value;
  if (!getPass()) { status('нужна парольная фраза'); return; }
  S = { lang, mode: $('mode').value, sens: Number($('sens').value), sources: new Set(), playAt: 0, playEnd: -Infinity, replyStart: 0, playEndWall: 0, lastRef: 0,
        segs: [], gate: 'send', preroll: [], loud: 0, coupling: 0.3, bargeActive: false, dropOld: false,
        turnStarted: false, lastVoice: 0, blockedSince: 0, userText: '', modelText: '', lastModelText: '', prevPartial: '', handle: null, closing: false };
  status('получение токена…');
  try {
    const r = await fetch(BACKEND + '/token', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Access-Key': getPass() }, body: JSON.stringify({ lang }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || r.status);
    S.token = d.token; S.model = d.model;
    S.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const st = S.mic.getAudioTracks()[0].getSettings();
    M.micSettings = `AEC=${st.echoCancellation} NS=${st.noiseSuppression} AGC=${st.autoGainControl}`; $('mset').textContent = M.micSettings;
    S.inCtx = new AudioContext();
    S.outCtx = new AudioContext({ sampleRate: 24000 });
    await S.inCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
    S.node = new AudioWorkletNode(S.inCtx, 'mlc-test-rec');
    S.node.port.onmessage = e => onMic(e.data);
    S.inCtx.createMediaStreamSource(S.mic).connect(S.node);
    connect();
    S.ui = setInterval(ui, 60);
    try { S.wake = await navigator.wakeLock?.request('screen'); } catch {}
  } catch (e) { status('ошибка: ' + e.message); stop(); }
}

function connect() {
  const me = S; me.ready = false;
  const ws = new WebSocket(`${WS_URL}?access_token=${encodeURIComponent(me.token)}`); me.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ setup: { model: me.model, sessionResumption: me.handle ? { handle: me.handle } : {} } }));
  ws.onmessage = async ev => { const t = typeof ev.data === 'string' ? ev.data : await ev.data.text(); let m; try { m = JSON.parse(t); } catch { return; } if (S === me) onServer(m); };
  ws.onclose = ev => {
    if (S !== me || me.ws !== ws || me.closing) return;
    if (me.handle) { status('переподключение…'); setTimeout(() => S === me && connect(), 300); }
    else { status('соединение закрыто: ' + (ev.reason || ev.code)); stop(); }
  };
}

/* ---------- playback ---------- */
const ECHO_WIN = 0.45;     // s — echo arrives late (output latency + air): compare against the loudest Gemini audio in this window
const GRACE = 0.6;         // s — no voice barge-in during the first 0.6 s of each Gemini reply (echo level is measured then)
const MIN_TAIL = 0.15, MAX_TAIL = 0.9;   // s — after Gemini stops, wait until the echo tail has died down
function speakingNow() { return S.sources.size > 0; }
function outRef() { const t = S.outCtx.currentTime; let m = 0; for (const s of S.segs) if (s.b > t - ECHO_WIN && s.a <= t) m = Math.max(m, s.rms); return m; }
function play(buf) {
  const ctx = S.outCtx, pcm = new Int16Array(buf), f = new Float32Array(pcm.length); let sq = 0;
  for (let i = 0; i < pcm.length; i++) { f[i] = pcm[i] / 32768; sq += f[i] * f[i]; }
  const ab = ctx.createBuffer(1, f.length, 24000); ab.copyToChannel(f, 0);
  const src = ctx.createBufferSource(); src.buffer = ab; src.connect(ctx.destination);
  const fresh = !speakingNow() && ctx.currentTime > S.playEnd;
  S.playAt = Math.max(S.playAt, ctx.currentTime + 0.03);
  if (fresh) S.replyStart = S.playAt;
  src.start(S.playAt); S.segs.push({ a: S.playAt, b: S.playAt + ab.duration, rms: Math.sqrt(sq / f.length) });
  S.playAt += ab.duration; S.playEnd = S.playAt;
  if (S.segs.length > 400) S.segs.splice(0, 200);
  S.sources.add(src); src.onended = () => S && S.sources.delete(src);
}
function flush() { S.sources.forEach(x => { try { x.stop(); } catch {} }); S.sources.clear(); S.playAt = 0; S.playEnd = S.outCtx.currentTime; S.segs = []; }

/* ---------- mic gate ---------- */
function send(pcm) { if (S.ready && S.ws?.readyState === 1) S.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(pcm), mimeType: 'audio/pcm;rate=16000' } } })); }
function open(reason) {
  if (S.gate === 'block') {
    // send recent mic audio recorded AFTER Gemini stopped (+150 ms), so a phrase started right away is not cut
    const after = S.preroll.filter(x => x.t > S.playEndWall + 150);
    (reason === 'barge' ? S.preroll : after).forEach(x => send(x.pcm));
    if (reason === 'tail') M.resume.push(Math.round(performance.now() - S.playEndWall));
  }
  S.preroll = [];
}
function onMic({ pcm, rms }) {
  if (!S) return;
  S.micRms = rms;
  const now = performance.now(), ct = S.outCtx.currentTime;
  if (S.bargeActive) { S.gate = 'barge'; if (rms > 0.03) S.lastVoice = now; send(pcm); return; }

  const speaking = speakingNow() || ct < S.playEnd;
  if (speaking) {
    if (S.gate !== 'block') { S.gate = 'block'; S.loud = 0; }
    S.playEndWall = now + Math.max(0, (S.playEnd - ct) * 1000);
    S.preroll.push({ pcm, t: now }); if (S.preroll.length > 10) S.preroll.shift();
    const ref = outRef();
    if (ref > 0.01) {
      const ratio = rms / ref;
      // echo level: peak-tracking during the grace period, then only slow growth (never learns from a loud user voice)
      if (ct - S.replyStart < GRACE) S.coupling = Math.max(S.coupling * 0.98, ratio);
      else if (ratio < S.coupling * 1.2) S.coupling = S.coupling * 0.97 + ratio * 0.03;
    }
    S.thr = Math.max(0.035, S.coupling * ref * S.sens);
    const canVoice = S.mode === 'voice' && ct - S.replyStart >= GRACE;
    if (canVoice && rms > S.thr) { if (++S.loud >= 6) bargeIn('voice'); } else S.loud = Math.max(0, S.loud - 1);
    return;
  }
  // Gemini finished: hold until the echo tail has died down (min 150 ms, max 900 ms)
  if (S.gate === 'block') {
    const since = (now - S.playEndWall) / 1000;
    const tailThr = Math.max(0.025, S.coupling * (S.lastRef || 0) * 0.5);
    S.preroll.push({ pcm, t: now }); if (S.preroll.length > 10) S.preroll.shift();
    if (since < MIN_TAIL || (since < MAX_TAIL && rms > tailThr)) return;
    open('tail');
  }
  S.gate = 'send'; S.loud = 0;
  if (rms > 0.03) S.lastVoice = now;
  send(pcm);
}
function bargeIn(kind) {
  if (!S || !(speakingNow() || S.outCtx.currentTime < S.playEnd)) return;
  if (kind === 'voice') { M.barges++; S.bargeCheck = { t: performance.now(), len: S.userText.length }; setTimeout(checkBarge, 3000); }
  else M.btn++;
  flush(); open('barge'); S.bargeActive = true; S.dropOld = S.turnStarted; S.gate = 'barge'; S.loud = 0; S.lastVoice = performance.now();
  log('s', kind === 'voice' ? '— вы перебили Gemini голосом —' : '— перебито кнопкой —');
}
// a voice barge-in is "false" if Gemini heard no new words from you within 3 s
function checkBarge() { if (!S?.bargeCheck) return; if (S.userText.length - S.bargeCheck.len < 3 && !S.lastUserAfterBarge) { M.falseBarge++; log('w', '⚠ ложное перебивание (эхо)'); } S.bargeCheck = null; S.lastUserAfterBarge = false; }
setInterval(() => { if (S) { const r = S.outCtx ? outRef() : 0; if (r > 0) S.lastRef = r; } }, 50);

/* ---------- server messages ---------- */
function onServer(m) {
  if (m.setupComplete) { S.ready = true; status('слушает'); }
  if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) S.handle = m.sessionResumptionUpdate.newHandle;
  if (m.goAway && S.handle) { try { S.ws.close(); } catch {} }
  if (m.toolCall) for (const fc of m.toolCall.functionCalls || []) runTool(fc);
  const sc = m.serverContent; if (!sc) return;
  if (sc.inputTranscription?.text) { S.userText += sc.inputTranscription.text; if (S.bargeCheck) S.lastUserAfterBarge = true; }
  if (sc.interrupted) { flush(); S.dropOld = false; endModelTurn(true); }
  for (const p of sc.modelTurn?.parts || []) {
    if (!p.inlineData?.data || S.dropOld) continue;
    if (!S.turnStarted) startModelTurn();
    play(unb64(p.inlineData.data));
  }
  if (sc.outputTranscription?.text && !S.dropOld) S.modelText += sc.outputTranscription.text;
  if (sc.turnComplete) { S.dropOld = false; endModelTurn(false); }
}
function startModelTurn() {
  S.turnStarted = true; S.bargeActive = false; M.turns++;
  if (S.lastVoice) M.lat.push(Math.round(performance.now() - S.lastVoice));
  const u = S.userText.trim();
  if (u) {
    log('u', 'Вы: ' + u);
    const words = u.toLowerCase().match(/[\p{L}\d']+/gu) || [], prev = (S.lastModelText + ' ' + S.prevPartial).toLowerCase();
    const hits = words.filter(w => w.length > 2 && prev.includes(w)).length;
    if (words.length >= 3 && hits / words.length >= 0.6) { M.echo++; log('w', '⚠ похоже, Gemini услышал собственный голос'); }
  }
  S.userText = ''; S.prevPartial = '';
}
function endModelTurn(interrupted) {
  if (!S.turnStarted) return;
  const t = S.modelText.trim(); if (t) log('g', 'Gemini: ' + t + (interrupted ? ' …(прерван)' : ''));
  S.lastModelText = t || S.lastModelText; S.prevPartial = t; S.modelText = ''; S.turnStarted = false;
}
async function runTool(fc) {
  const me = S; let response;
  try {
    const r = await fetch(BACKEND + '/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Access-Key': getPass() }, body: JSON.stringify({ lang: me.lang, args: fc.args || {} }) });
    const d = await r.json(); response = d.ok ? { result: d.result, source: d.source } : { error: d.error || 'search_failed' };
    log('s', `поиск: ${fc.args?.query || ''} → ${d.ok ? d.source : d.error}`);
  } catch { response = { error: 'search_unavailable' }; }
  if (S !== me || me.ws?.readyState !== 1) return;
  me.ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { ...response, scheduling: 'WHEN_IDLE' } }] } }));
}

/* ---------- UI ---------- */
const avg = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length / 1000).toFixed(2) + ' с' : '—';
function ui() {
  if (!S) return;
  const g = $('gate');
  g.className = 'gate ' + S.gate;
  g.textContent = S.gate === 'send' ? '🎙 Микрофон отправляется' : S.gate === 'barge' ? '🎙 Перебивание — отправляется' : '⏸ Gemini говорит — микрофон на паузе';
  $('micbar').style.width = Math.min(100, (S.micRms || 0) * 400) + '%';
  $('thr').style.left = Math.min(100, (S.gate === 'block' ? S.thr || 0 : 0) * 400) + '%';
  $('outbar').style.width = Math.min(100, (S.outCtx ? outRef() : 0) * 400) + '%';
  $('coup').textContent = Math.round(S.coupling * 100) + '%';
  $('nturns').textContent = M.turns; $('nbarge').textContent = M.barges; $('nfalse').textContent = M.falseBarge; $('nbtn').textContent = M.btn; $('necho').textContent = M.echo;
  $('lat').textContent = avg(M.lat);
  $('resume').textContent = avg(M.resume);
  render();
}
function stop() {
  const me = S; if (!me) return; S = null; me.closing = true;
  clearInterval(me.ui);
  try { me.ws?.close(); } catch {}
  me.mic?.getTracks().forEach(t => t.stop());
  me.inCtx?.close().catch(() => {}); me.outCtx?.close().catch(() => {});
  try { me.wake?.release(); } catch {}
  $('gate').className = 'gate'; $('gate').textContent = '—'; status('завершено');
  render();
}
document.querySelectorAll('[data-q]').forEach(row => row.dataset.a.split('|').forEach(a => {
  const b = document.createElement('button'); b.textContent = a;
  b.onclick = () => { answers[row.dataset.q] = a; row.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b)); render(); };
  row.appendChild(b);
}));
function render() {
  $('out').value = [
    'Live media test — ' + navigator.userAgent,
    `v3 язык=${$('lang').value} режим=${$('mode').selectedOptions[0].text} чувствительность=${$('sens').selectedOptions[0].text} микрофон: ${M.micSettings}`,
    `ответов=${M.turns} перебиваний_голосом=${M.barges} ложных=${M.falseBarge} кнопкой=${M.btn} подозрений_на_эхо=${M.echo} время_ответа=${avg(M.lat)} микрофон_снова_слушает_через=${avg(M.resume)}`,
    `ползунок=${answers.slider || '—'}; громкость_меняется=${answers.volume || '—'}; слышит_себя=${answers.echo || '—'}; обрывы_фраз=${answers.cut || '—'}; перебивание=${answers.bargein || '—'}; лучший_режим=${answers.best || '—'}; качество=${answers.quality || '—'}`
  ].join('\n');
}
$('start').onclick = start;
$('stop').onclick = stop;
$('interrupt').onclick = () => S && bargeIn('button');
$('copy').onclick = async () => { const t = $('out'); t.select(); try { await navigator.clipboard.writeText(t.value); } catch { document.execCommand('copy'); } $('copy').textContent = 'Скопировано ✓'; };
render();
