'use strict';
/* Test 4 — mic always on; WebRTC AEC3 (wasm, in an AudioWorklet) removes Gemini's voice from the mic.
   - getUserMedia without browser echoCancellation/NS/AGC → Android Media stream (test 1, mode B)
   - one AudioContext: Gemini's audio → speaker AND → AEC reference input; mic → AEC mic input
   - cleaned audio is sent to Gemini continuously; if the user's voice is detected while Gemini speaks,
     Gemini's playback stops at once (Gemini also stops on its own when it hears the user).
   Uses the existing Worker (/token, /search) unchanged. */
const BACKEND = 'https://my-language-coach-api.seambad.workers.dev';
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const $ = id => document.getElementById(id);
let S = null;
const M = { turns: 0, local: 0, srv: 0, lat: [], erle: [], cpu: [], delay: null, rate: null, mic: '—' };
const answers = {};

const getPass = () => { try { const p = localStorage.getItem('mlc.passphrase'); if (p) return p; } catch {} return $('pass').value.trim(); };
try { if (!localStorage.getItem('mlc.passphrase')) $('passRow').style.display = 'flex'; } catch { $('passRow').style.display = 'flex'; }
const b64 = buf => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = str => { const b = atob(str), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
const status = t => { $('st').textContent = t; };
function log(cls, text) { const p = document.createElement('p'); p.className = cls; p.textContent = text; $('log').prepend(p); }

async function start() {
  if (S) return;
  if (!getPass()) { status('нужна парольная фраза'); return; }
  const lang = $('lang').value;
  S = { lang, sources: new Set(), playAt: 0, dropOld: false, turnOn: false, userText: '', modelText: '', voiceRun: 0, floor: 0.01, lastVoice: 0, rawRms: 0 };
  status('загрузка эхоподавителя…');
  try {
    const wasm = await WebAssembly.compileStreaming(fetch('aec3/webrtc-audio-processing.wasm'));
    const r = await fetch(BACKEND + '/token', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Access-Key': getPass() }, body: JSON.stringify({ lang }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || r.status);
    S.token = d.token; S.model = d.model;
    S.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    const st = S.mic.getAudioTracks()[0].getSettings(); M.mic = `AEC=${st.echoCancellation} NS=${st.noiseSuppression} AGC=${st.autoGainControl}`; $('mset').textContent = M.mic;
    S.ctx = new AudioContext({ sampleRate: 48000 });
    M.rate = S.ctx.sampleRate; $('rate').textContent = M.rate + ' Гц';
    await S.ctx.audioWorklet.addModule('aec-worklet.js');
    S.aec = new AudioWorkletNode(S.ctx, 'mlc-aec', { numberOfInputs: 2, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', processorOptions: { module: wasm } });
    S.aec.port.onmessage = e => onMic(e.data);
    S.aec.onprocessorerror = () => { log('w', 'ошибка эхоподавителя'); status('ошибка эхоподавителя'); };
    const sink = S.ctx.createGain(); sink.gain.value = 0; S.aec.connect(sink); sink.connect(S.ctx.destination);
    const src = S.ctx.createMediaStreamSource(S.mic); src.connect(S.aec, 0, 0);
    S.an = S.ctx.createAnalyser(); S.an.fftSize = 512; src.connect(S.an); S.anBuf = new Float32Array(512);
    S.bus = S.ctx.createGain(); S.bus.connect(S.ctx.destination); S.bus.connect(S.aec, 0, 1);       // speaker + AEC reference
    S.outAn = S.ctx.createAnalyser(); S.outAn.fftSize = 512; S.bus.connect(S.outAn);
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
  ws.onclose = ev => { if (S !== me || me.ws !== ws || me.closing) return; if (me.handle) { status('переподключение…'); setTimeout(() => S === me && connect(), 300); } else { status('соединение закрыто: ' + (ev.reason || ev.code)); stop(); } };
}
const speaking = () => S && S.sources.size > 0;
function play(buf) {
  const pcm = new Int16Array(buf), f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
  const ab = S.ctx.createBuffer(1, f.length, 24000); ab.copyToChannel(f, 0);
  const src = S.ctx.createBufferSource(); src.buffer = ab; src.connect(S.bus);
  S.playAt = Math.max(S.playAt, S.ctx.currentTime + 0.03); src.start(S.playAt); S.playAt += ab.duration;
  S.sources.add(src); src.onended = () => S && S.sources.delete(src);
}
function flush() { S.sources.forEach(x => { try { x.stop(); } catch {} }); S.sources.clear(); S.playAt = 0; }

// cleaned mic chunk (50 ms, 16 kHz) from the AEC worklet — always sent to Gemini
function onMic({ pcm, rms, vad, stats }) {
  if (!S) return;
  S.micRms = rms;
  if (stats) { if (stats.erle != null) M.erle.push(stats.erle); if (stats.delay != null) M.delay = stats.delay; M.cpu.push(stats.cpu); }
  const voice = vad >= 0.5 && rms > Math.max(0.006, S.floor * 3);
  if (!voice) S.floor = S.floor * 0.98 + Math.min(rms, 0.05) * 0.02;
  if (voice) S.lastVoice = performance.now();
  // user speaks while Gemini talks → stop Gemini's voice immediately (≈100 ms of speech)
  if (speaking() && voice) { if (++S.voiceRun >= 2) { M.local++; S.dropOld = S.turnOn; flush(); log('s', '— вы перебили Gemini —'); S.voiceRun = 0; } }
  else S.voiceRun = 0;
  if (S.ready && S.ws?.readyState === 1) S.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(pcm), mimeType: 'audio/pcm;rate=16000' } } }));
}
function onServer(m) {
  if (m.setupComplete) { S.ready = true; status('слушает'); }
  if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) S.handle = m.sessionResumptionUpdate.newHandle;
  if (m.goAway && S.handle) { try { S.ws.close(); } catch {} }
  if (m.toolCall) for (const fc of m.toolCall.functionCalls || []) runTool(fc);
  const sc = m.serverContent; if (!sc) return;
  if (sc.inputTranscription?.text) S.userText += sc.inputTranscription.text;
  if (sc.interrupted) { M.srv++; flush(); S.dropOld = false; endTurn(true); }
  for (const p of sc.modelTurn?.parts || []) {
    if (!p.inlineData?.data || S.dropOld) continue;
    if (!S.turnOn) { S.turnOn = true; M.turns++; if (S.lastVoice) M.lat.push(Math.round(performance.now() - S.lastVoice)); const u = S.userText.trim(); if (u) log('u', 'Вы: ' + u); S.userText = ''; }
    play(unb64(p.inlineData.data));
  }
  if (sc.outputTranscription?.text && !S.dropOld) S.modelText += sc.outputTranscription.text;
  if (sc.turnComplete) { S.dropOld = false; endTurn(false); }
}
function endTurn(interrupted) { if (!S.turnOn) return; const t = S.modelText.trim(); if (t) log('', 'Gemini: ' + t + (interrupted ? ' …(прерван)' : '')); S.modelText = ''; S.turnOn = false; }
async function runTool(fc) {
  const me = S; let response;
  try { const r = await fetch(BACKEND + '/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Access-Key': getPass() }, body: JSON.stringify({ lang: me.lang, args: fc.args || {} }) });
    const d = await r.json(); response = d.ok ? { result: d.result, source: d.source } : { error: d.error || 'search_failed' }; log('s', `поиск: ${fc.args?.query || ''} → ${d.ok ? d.source : d.error}`);
  } catch { response = { error: 'search_unavailable' }; }
  if (S !== me || me.ws?.readyState !== 1) return;
  me.ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { ...response, scheduling: 'WHEN_IDLE' } }] } }));
}
const avg = (a, f = 1, u = '') => a.length ? (a.reduce((x, y) => x + y, 0) / a.length * f).toFixed(1) + u : '—';
const level = (an, buf) => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length); };
function ui() {
  if (!S || !S.an) return;
  $('rawbar').style.width = Math.min(100, level(S.an, S.anBuf) * 400) + '%';
  $('micbar').style.width = Math.min(100, (S.micRms || 0) * 400) + '%';
  $('outbar').style.width = Math.min(100, level(S.outAn, S.anBuf) * 400) + '%';
  $('gate').textContent = speaking() ? '🔊 Gemini говорит — микрофон слушает' : '🎙 Микрофон слушает';
  $('erle').textContent = M.erle.length ? M.erle.at(-1).toFixed(0) + ' дБ' : '—';
  $('delay').textContent = M.delay != null ? M.delay + ' мс' : '—';
  $('cpu').textContent = M.cpu.length ? M.cpu.at(-1).toFixed(1) + '%' : '—';
  $('nturns').textContent = M.turns; $('nlocal').textContent = M.local; $('nsrv').textContent = M.srv;
  $('lat').textContent = avg(M.lat, 0.001, ' с');
  render();
}
function stop() {
  const me = S; if (!me) return; S = null; me.closing = true; clearInterval(me.ui);
  try { me.ws?.close(); } catch {}
  me.mic?.getTracks().forEach(t => t.stop()); me.ctx?.close().catch(() => {});
  try { me.wake?.release(); } catch {}
  $('gate').textContent = '—'; status('завершено'); render();
}
document.querySelectorAll('[data-q]').forEach(row => row.dataset.a.split('|').forEach(a => {
  const b = document.createElement('button'); b.textContent = a;
  b.onclick = () => { answers[row.dataset.q] = a; row.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b)); render(); };
  row.appendChild(b);
}));
function render() {
  $('out').value = [
    'Echo cancel test 4 — ' + navigator.userAgent,
    `язык=${$('lang').value} частота=${M.rate} микрофон: ${M.mic}`,
    `подавление_эха_ср=${avg(M.erle, 1, 'дБ')} задержка_эха=${M.delay ?? '—'}мс нагрузка_ср=${avg(M.cpu, 1, '%')} нагрузка_макс=${M.cpu.length ? Math.max(...M.cpu).toFixed(1) + '%' : '—'}`,
    `ответов=${M.turns} остановок_по_голосу=${M.local} прерываний_от_Gemini=${M.srv} время_ответа=${avg(M.lat, 0.001, 'с')}`,
    `ползунок=${answers.slider || '—'}; громкость=${answers.volume || '—'}; перебивание=${answers.barge || '—'}; сам_себя=${answers.self || '—'}; фразы=${answers.cut || '—'}; понимание=${answers.understand || '—'}; качество=${answers.quality || '—'}`
  ].join('\n');
}
$('start').onclick = start; $('stop').onclick = stop;
$('copy').onclick = async () => { const t = $('out'); t.select(); try { await navigator.clipboard.writeText(t.value); } catch { document.execCommand('copy'); } $('copy').textContent = 'Скопировано ✓'; };
render();
