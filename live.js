'use strict';
/* Gemini Live client: mic capture (16 kHz PCM) → WebSocket → playback (24 kHz PCM).
   Auth uses a short-lived ephemeral token from our Worker; the API key never reaches the browser.
   Protocol: https://ai.google.dev/api/live

   Primary audio mode "aec" (verified on Galaxy S25 Ultra / Samsung Internet 31, tests/aec-test.html):
   the mic is opened WITHOUT browser echo cancellation (Android keeps the Media volume stream) and
   WebRTC AEC3 (wasm, aec-worklet.js) removes Gemini's voice using the exact speaker signal as reference.
   The mic is sent to Gemini continuously; when the user's voice is detected while Gemini speaks,
   Gemini's playback stops at once (Gemini also stops server-side when it hears the user).

   Fallback mode "gate" (only if AEC3 cannot load; tests/live-media-test.html v3):
   the mic is opened WITHOUT browser echo cancellation, so Android keeps the "Media" stream and the
   hardware volume keys control Gemini's voice. Echo is handled here instead:
   - while Gemini speaks, mic audio is not sent (compared against the loudest output in the last 0.45 s,
     because echo arrives late);
   - after Gemini stops, sending resumes once the echo tail has died down (0.15–0.9 s);
   - voice barge-in: clearly louder-than-echo speech for ~0.3 s stops Gemini immediately and sends the
     user's speech (incl. the last 0.5 s) — same behaviour as test 3 verified on the phone;
   - interrupt() stops Gemini immediately (used by the mic button). */
const Live = (() => {
  const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
  const PASS_KEY = 'mlc.passphrase';

  // AudioWorklet: downsamples the mic to 16 kHz Int16 and posts 50 ms chunks with their RMS level.
  const CHUNK = 800;
  const WORKLET = `
  class Rec extends AudioWorkletProcessor {
    constructor(){ super(); this.ratio = sampleRate/16000; this.buf = new Int16Array(${CHUNK}); this.n = 0; this.pos = 0; this.sq = 0; }
    process(inputs){
      const ch = inputs[0][0]; if (!ch) return true;
      for (; this.pos < ch.length; this.pos += this.ratio) {
        const v = Math.max(-1, Math.min(1, ch[Math.floor(this.pos)]));
        this.sq += v * v; this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === ${CHUNK}) { this.port.postMessage({ pcm: this.buf.buffer, rms: Math.sqrt(this.sq / ${CHUNK}) }, [this.buf.buffer]); this.buf = new Int16Array(${CHUNK}); this.n = 0; this.sq = 0; }
      }
      this.pos -= ch.length;
      return true;
    }
  }
  registerProcessor('mlc-rec', Rec);`;

  // Echo gate tuning (from test 3)
  const ECHO_WIN = 0.45, GRACE = 0.6, MIN_TAIL = 0.15, MAX_TAIL = 0.9;
  const SENS = 2, BARGE_CHUNKS = 6, PREROLL = 10;

  let s = null; // active session state

  const enabled = () => !!(window.MLC_CONFIG && window.MLC_CONFIG.backendUrl);
  const getPass = () => { try { return localStorage.getItem(PASS_KEY) || ''; } catch { return ''; } };
  const setPass = p => { try { localStorage.setItem(PASS_KEY, p); } catch {} };

  async function fetchToken(lang) {
    const r = await fetch(window.MLC_CONFIG.backendUrl.replace(/\/$/, '') + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Access-Key': getPass() },
      body: JSON.stringify({ lang })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || 'token_failed'); e.status = r.status; throw e; }
    return data;
  }

  const b64 = buf => { let bin = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(bin); };
  const unb64 = str => { const bin = atob(str); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };

  async function start(lang, cb) {
    if (s) stop();
    s = { lang, cb, muted: false, handle: null, closing: false, reconnects: 0, playAt: 0, sources: new Set(), coachText: '', cancelled: new Set(),
          playEnd: -Infinity, replyStart: 0, playEndWall: 0, segs: [], lastRef: 0, coupling: 0.3, gate: 'send', preroll: [], loud: 0,
          bargeActive: false, dropOld: false, turnOn: false };
    const me = s;
    cb.status?.('connecting');
    const tk = await fetchToken(lang);          // throws on auth / quota errors
    if (s !== me) return;
    s.token = tk.token; s.model = tk.model;

    // Audio graph — echoCancellation:false keeps Android on the Media stream (see header)
    try { await setupAec(me); }
    catch (e) {
      if (s !== me) return;
      console.warn('AEC3 unavailable, using mic gate fallback:', e);
      teardownAudio(me);
      await setupGate(me);
    }
    if (s !== me) return;
    connect();
  }

  // Primary: one 48 kHz context; Gemini's voice → speaker and → AEC reference; mic → AEC.
  async function setupAec(me) {
    const wasm = await WebAssembly.compileStreaming(fetch(new URL('aec3/webrtc-audio-processing.wasm', document.baseURI)));
    me.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    if (s !== me) { me.micStream.getTracks().forEach(t => t.stop()); throw new Error('stopped'); }
    const ctx = me.inCtx = me.outCtx = new AudioContext({ sampleRate: 48000 });
    if (ctx.sampleRate % 16000) throw new Error('sample rate ' + ctx.sampleRate);
    await ctx.audioWorklet.addModule(new URL('aec-worklet.js', document.baseURI));
    me.node = new AudioWorkletNode(ctx, 'mlc-aec', { numberOfInputs: 2, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', processorOptions: { module: wasm } });
    me.node.port.onmessage = e => onMicAec(e.data);
    me.node.onprocessorerror = () => { if (s === me) me.cb.error?.('Echo canceller stopped'); };
    const sink = ctx.createGain(); sink.gain.value = 0; me.node.connect(sink); sink.connect(ctx.destination);   // keeps the worklet running
    me.src = ctx.createMediaStreamSource(me.micStream); me.src.connect(me.node, 0, 0);
    me.bus = ctx.createGain(); me.bus.connect(ctx.destination); me.bus.connect(me.node, 0, 1);              // speaker + AEC reference
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    me.mode = 'aec'; me.floor = 0.01; me.voiceRun = 0;
  }
  // Fallback: mic gate (no AEC) — pauses the mic while Gemini speaks.
  async function setupGate(me) {
    me.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    if (s !== me) { me.micStream.getTracks().forEach(t => t.stop()); return; }
    me.inCtx = new AudioContext();
    me.outCtx = new AudioContext({ sampleRate: 24000 });
    await me.inCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
    me.src = me.inCtx.createMediaStreamSource(me.micStream);
    me.node = new AudioWorkletNode(me.inCtx, 'mlc-rec');
    me.node.port.onmessage = e => onMic(e.data);
    me.src.connect(me.node);
    me.mode = 'gate';
  }
  function teardownAudio(me) {
    try { me.src?.disconnect(); me.node?.disconnect(); } catch {}
    me.micStream?.getTracks().forEach(t => t.stop());
    me.inCtx?.close().catch(() => {}); if (me.outCtx !== me.inCtx) me.outCtx?.close().catch(() => {});
    me.src = me.node = me.micStream = me.inCtx = me.outCtx = me.bus = null;
  }

  // AEC mode: cleaned mic is always sent; the user's voice during Gemini's speech stops playback at once.
  function onMicAec({ pcm, rms, vad, stats }) {
    if (!s || s.mode !== 'aec') return;
    if (stats) s.aecStats = stats;
    if (s.muted) return;
    const voice = vad >= 0.5 && rms > Math.max(0.006, s.floor * 3);
    if (!voice) s.floor = s.floor * 0.98 + Math.min(rms, 0.05) * 0.02;
    if (voice && isSpeaking()) { if (++s.voiceRun >= 2) { s.voiceRun = 0; s.dropOld = s.turnOn; flushPlayback(); } }
    else s.voiceRun = 0;
    send(pcm);
  }

  function connect() {
    const me = s; if (!me) return;
    me.ready = false;
    const ws = new WebSocket(`${WS_URL}?access_token=${encodeURIComponent(me.token)}`);
    me.ws = ws;
    ws.onopen = () => {
      const setup = { model: me.model, sessionResumption: me.handle ? { handle: me.handle } : {} };
      ws.send(JSON.stringify({ setup }));
    };
    ws.onmessage = async ev => {
      const text = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      let m; try { m = JSON.parse(text); } catch { return; }
      if (s !== me) return;
      handle(m);
    };
    ws.onclose = ev => {
      if (s !== me || me.ws !== ws || me.closing) return;
      me.ready = false;
      // Server resets connections ~every 10 min; resume the same session if we have a handle.
      if (me.handle && me.reconnects < 5) {
        me.reconnects++; me.cb.status?.('reconnecting');
        setTimeout(() => s === me && connect(), 400);
      } else {
        me.cb.error?.(ev.reason || `Connection closed (${ev.code})`);
        stop();
      }
    };
  }

  function handle(m) {
    if (m.setupComplete) { s.ready = true; s.reconnects = 0; s.cb.status?.('live'); }
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) s.handle = m.sessionResumptionUpdate.newHandle;
    if (m.goAway && s.handle) { s.cb.status?.('reconnecting'); try { s.ws.close(); } catch {} } // onclose resumes
    if (m.toolCall) for (const fc of m.toolCall.functionCalls || []) runTool(fc);
    if (m.toolCallCancellation) for (const id of m.toolCallCancellation.ids || []) s.cancelled.add(id);
    const sc = m.serverContent; if (!sc) return;
    if (sc.interrupted) { flushPlayback(); s.dropOld = false; s.turnOn = false; }
    if (sc.inputTranscription?.text) s.cb.user?.(sc.inputTranscription.text);
    for (const p of sc.modelTurn?.parts || []) {
      if (!p.inlineData?.data || s.dropOld) continue;
      if (!s.turnOn) { s.turnOn = true; s.bargeActive = false; s.coachText = ''; }
      play(unb64(p.inlineData.data));
    }
    if (sc.outputTranscription?.text && !s.dropOld) { s.coachText += sc.outputTranscription.text; s.cb.coach?.(s.coachText.trim()); }
    if (sc.turnComplete) { s.coachText = ''; s.dropOld = false; s.turnOn = false; }
  }

  // Gemini asked for web_search: run it on our Worker and return the result into the SAME session.
  async function runTool(fc) {
    const me = s; if (!me) return;
    let response;
    if (fc.name !== 'web_search') response = { error: 'unknown_function' };
    else {
      me.cb.searching?.(true);
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
        const r = await fetch(window.MLC_CONFIG.backendUrl.replace(/\/$/, '') + '/search', {
          method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', 'X-Access-Key': getPass() },
          body: JSON.stringify({ lang: me.lang, args: fc.args || {} })
        });
        clearTimeout(t);
        const d = await r.json().catch(() => ({}));
        response = d.ok ? { result: d.result, source: d.source } : { error: d.error || 'search_failed' };
      } catch { response = { error: 'search_unavailable' }; }
      me.cb.searching?.(false);
    }
    if (s !== me || me.cancelled.has(fc.id) || me.ws?.readyState !== 1) return;
    me.ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { ...response, scheduling: 'WHEN_IDLE' } }] } }));
  }

  /* ---------- playback ---------- */
  function play(buf) {
    const ctx = s.outCtx, pcm = new Int16Array(buf), f = new Float32Array(pcm.length); let sq = 0;
    for (let i = 0; i < pcm.length; i++) { f[i] = pcm[i] / 32768; sq += f[i] * f[i]; }
    const ab = ctx.createBuffer(1, f.length, 24000); ab.copyToChannel(f, 0);
    const src = ctx.createBufferSource(); src.buffer = ab; src.connect(s.bus || ctx.destination);
    if (!s.sources.size && ctx.currentTime > s.playEnd) s.replyStart = Math.max(s.playAt, ctx.currentTime + 0.03);
    s.playAt = Math.max(s.playAt, ctx.currentTime + 0.03);
    src.start(s.playAt);
    s.segs.push({ a: s.playAt, b: s.playAt + ab.duration, rms: Math.sqrt(sq / f.length) }); if (s.segs.length > 400) s.segs.splice(0, 200);
    s.playAt += ab.duration; s.playEnd = s.playAt;
    s.sources.add(src); s.cb.speaking?.(true);
    src.onended = () => { s?.sources.delete(src); if (s && !s.sources.size) s.cb.speaking?.(false); };
  }
  function flushPlayback() {
    s.sources.forEach(x => { try { x.stop(); } catch {} }); s.sources.clear(); s.playAt = 0; s.segs = [];
    s.playEnd = s.outCtx ? s.outCtx.currentTime : -Infinity;
    if (s.outCtx?.state === 'suspended') s.outCtx.resume().catch(() => {});
    s.cb.speaking?.(false);
  }
  const isSpeaking = () => !!s?.outCtx && (s.sources.size > 0 || s.outCtx.currentTime < s.playEnd);
  // loudest Gemini output in the last ECHO_WIN seconds (echo reaches the mic late)
  function outRef() { const t = s.outCtx.currentTime; let m = 0; for (const x of s.segs) if (x.b > t - ECHO_WIN && x.a <= t) m = Math.max(m, x.rms); if (m) s.lastRef = m; return m; }

  /* ---------- mic gate (replaces browser echo cancellation) ---------- */
  function send(pcm) { if (s.ready && s.ws?.readyState === 1) s.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(pcm), mimeType: 'audio/pcm;rate=16000' } } })); }
  function openGate(all) {
    if (s.gate === 'block') (all ? s.preroll : s.preroll.filter(x => x.t > s.playEndWall + 150)).forEach(x => send(x.pcm));
    s.preroll = []; s.loud = 0;
  }
  function onMic({ pcm, rms }) {
    if (!s || !s.outCtx) return;
    if (s.muted) { s.preroll = []; return; }
    const now = performance.now(), ct = s.outCtx.currentTime;
    if (s.bargeActive) { send(pcm); return; }
    if (isSpeaking()) {
      s.gate = 'block';
      s.playEndWall = now + Math.max(0, (s.playEnd - ct) * 1000);
      s.preroll.push({ pcm, t: now }); if (s.preroll.length > PREROLL) s.preroll.shift();
      const ref = outRef();
      if (ref > 0.01) {
        const ratio = rms / ref;
        if (ct - s.replyStart < GRACE) s.coupling = Math.max(s.coupling * 0.98, ratio);   // learn the echo level
        else if (ratio < s.coupling * 1.2) s.coupling = s.coupling * 0.97 + ratio * 0.03;
      }
      const thr = Math.max(0.035, s.coupling * ref * SENS);
      if (ct - s.replyStart >= GRACE && rms > thr) { if (++s.loud >= BARGE_CHUNKS) voiceBarge(); }
      else s.loud = Math.max(0, s.loud - 1);
      return;
    }
    if (s.gate === 'block') {   // Gemini just finished: wait for the echo tail to die down
      const since = (now - s.playEndWall) / 1000, tailThr = Math.max(0.025, s.coupling * s.lastRef * 0.5);
      s.preroll.push({ pcm, t: now }); if (s.preroll.length > PREROLL) s.preroll.shift();
      if (since < MIN_TAIL || (since < MAX_TAIL && rms > tailThr)) return;
      openGate(false);
    }
    s.gate = 'send';
    send(pcm);
  }
  // Voice barge-in (as in test 3): stop Gemini now, drop the rest of this reply, send the user's speech.
  function voiceBarge() {
    openGate(true);
    s.dropOld = s.turnOn; flushPlayback(); s.bargeActive = true; s.gate = 'barge';
  }
  // Mic button while Gemini speaks: stop immediately and listen.
  function interrupt() {
    if (!s || !isSpeaking()) return false;
    s.dropOld = s.turnOn; flushPlayback(); s.bargeActive = true; s.gate = 'barge'; s.preroll = [];
    return true;
  }

  function setMuted(m) { if (s) s.muted = m; }

  function stop() {
    const me = s; if (!me) return; s = null;
    me.closing = true;
    try { me.ws?.close(); } catch {}
    try { me.src?.disconnect(); me.node?.disconnect(); } catch {}
    me.micStream?.getTracks().forEach(t => t.stop());
    me.inCtx?.close().catch(() => {}); if (me.outCtx !== me.inCtx) me.outCtx?.close().catch(() => {});
  }

  return { enabled, start, stop, setMuted, getPass, setPass, interrupt, speaking: isSpeaking, active: () => !!s,
           mode: () => s?.mode || null, aecStats: () => s?.aecStats || null };
})();
