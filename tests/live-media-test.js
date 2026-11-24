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
const PREROLL = 6;            // 300 ms of mic kept while blocked, sent on barge-in
const BARGE_CHUNKS = 3;       // 150 ms above threshold → barge-in
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
const M = { turns: 0, barges: 0, echo: 0, lat: [], resume: [], micSettings: '—' };
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
  S = { lang, hang: Number($('hang').value), sens: Number($('sens').value), bargeOn: $('barge').checked, sources: new Set(), playAt: 0, playEnd: -Infinity,
        segs: [], gate: 'send', preroll: [], loud: 0, coupling: 0.4, bargeActive: false, dropOld: false,
        turnStarted: false, lastVoice: 0, blockedSince: 0, userText: '', modelText: '', lastModelText: '', handle: null, closing: false };
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
const playing = () => S.sources.size > 0 || S.outCtx.currentTime < S.playEnd + S.hang / 1000;
function outRmsNow() { const t = S.outCtx.currentTime; const s = S.segs.find(x => t >= x.a && t < x.b); return s ? s.rms : 0; }
function play(buf) {
  const ctx = S.outCtx, pcm = new Int16Array(buf), f = new Float32Array(pcm.length); let sq = 0;
  for (let i = 0; i < pcm.length; i++) { f[i] = pcm[i] / 32768; sq += f[i] * f[i]; }
  const ab = ctx.createBuffer(1, f.length, 24000); ab.copyToChannel(f, 0);
  const src = ctx.createBufferSource(); src.buffer = ab; src.connect(ctx.destination);
  S.playAt = Math.max(S.playAt, ctx.currentTime + 0.03);
  src.start(S.playAt); S.segs.push({ a: S.playAt, b: S.playAt + ab.duration, rms: Math.sqrt(sq / f.length) });
  S.playAt += ab.duration; S.playEnd = S.playAt;
  if (S.segs.length > 400) S.segs.splice(0, 200);
  S.sources.add(src); src.onended = () => S && S.sources.delete(src);
}
function flush() { S.sources.forEach(x => { try { x.stop(); } catch {} }); S.sources.clear(); S.playAt = 0; S.playEnd = -Infinity; S.segs = []; }

/* ---------- mic gate ---------- */
function send(pcm) { if (S.ready && S.ws?.readyState === 1) S.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(pcm), mimeType: 'audio/pcm;rate=16000' } } })); }
function onMic({ pcm, rms }) {
  if (!S) return;
  S.micRms = rms;
  const now = performance.now();
  if (S.bargeActive || !playing()) {
    S.gate = S.bargeActive ? 'barge' : 'send'; S.loud = 0;
    if (rms > 0.03) S.lastVoice = now;
    send(pcm); return;
  }
  // Gemini is speaking: block mic, learn echo level, detect barge-in
  if (S.gate !== 'block') { S.gate = 'block'; S.blockedSince = now; }
  S.preroll.push(pcm); if (S.preroll.length > PREROLL) S.preroll.shift();
  const out = outRmsNow();
  S.thr = Math.max(0.03, S.coupling * out * S.sens);
  if (out > 0.02) { const ratio = rms / out; if (ratio < S.coupling * 2.5) S.coupling = S.coupling * 0.95 + ratio * 0.05; }
  if (S.bargeOn && rms > S.thr) { if (++S.loud >= BARGE_CHUNKS) bargeIn(); } else S.loud = 0;
}
function bargeIn() {
  M.barges++; flush(); S.bargeActive = true; S.dropOld = S.turnStarted; S.gate = 'barge'; S.loud = 0;
  S.preroll.forEach(send); S.preroll = []; S.lastVoice = performance.now();
  log('s', '— вы перебили Gemini —');
}

/* ---------- server messages ---------- */
function onServer(m) {
  if (m.setupComplete) { S.ready = true; status('слушает'); }
  if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) S.handle = m.sessionResumptionUpdate.newHandle;
  if (m.goAway && S.handle) { try { S.ws.close(); } catch {} }
  if (m.toolCall) for (const fc of m.toolCall.functionCalls || []) runTool(fc);
  const sc = m.serverContent; if (!sc) return;
  if (sc.inputTranscription?.text) S.userText += sc.inputTranscription.text;
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
    const words = u.toLowerCase().match(/[\p{L}\d']+/gu) || [], prev = S.lastModelText.toLowerCase();
    const hits = words.filter(w => w.length > 2 && prev.includes(w)).length;
    if (words.length >= 3 && hits / words.length >= 0.6) { M.echo++; log('w', '⚠ похоже, Gemini услышал собственный голос'); }
  }
  S.userText = '';
}
function endModelTurn(interrupted) {
  if (!S.turnStarted) return;
  const t = S.modelText.trim(); if (t) log('g', 'Gemini: ' + t + (interrupted ? ' …(прерван)' : ''));
  S.lastModelText = t || S.lastModelText; S.modelText = ''; S.turnStarted = false;
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
  $('outbar').style.width = Math.min(100, (S.outCtx ? outRmsNow() : 0) * 400) + '%';
  $('coup').textContent = Math.round(S.coupling * 100) + '%';
  $('nturns').textContent = M.turns; $('nbarge').textContent = M.barges; $('necho').textContent = M.echo;
  $('lat').textContent = avg(M.lat);
  $('resume').textContent = (S.hang / 1000).toFixed(2) + ' с после конца речи';
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
    `язык=${$('lang').value} пауза=${$('hang').value}мс перебивание=${$('barge').checked ? 'вкл' : 'выкл'} чувствительность=${$('sens').selectedOptions[0].text} микрофон: ${M.micSettings}`,
    `ответов=${M.turns} перебиваний=${M.barges} подозрений_на_эхо=${M.echo} среднее_время_ответа=${avg(M.lat)}`,
    `ползунок=${answers.slider || '—'}; громкость_меняется=${answers.volume || '—'}; слышит_себя=${answers.echo || '—'}; обрывы_фраз=${answers.cut || '—'}; перебивание=${answers.bargein || '—'}; качество=${answers.quality || '—'}`
  ].join('\n');
}
$('start').onclick = start;
$('stop').onclick = stop;
$('copy').onclick = async () => { const t = $('out'); t.select(); try { await navigator.clipboard.writeText(t.value); } catch { document.execCommand('copy'); } $('copy').textContent = 'Скопировано ✓'; };
render();
