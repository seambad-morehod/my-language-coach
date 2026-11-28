'use strict';
/* Gemini Live client: mic capture (16 kHz PCM) → WebSocket → playback (24 kHz PCM).
   Auth uses a short-lived ephemeral token from our Worker; the API key never reaches the browser.
   Protocol: https://ai.google.dev/api/live */
const Live = (() => {
  const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
  const PASS_KEY = 'mlc.passphrase';

  // AudioWorklet: collects mic samples, downsamples to 16 kHz Int16, posts ~100 ms chunks.
  const WORKLET = `
  class Rec extends AudioWorkletProcessor {
    constructor(){ super(); this.ratio = sampleRate/16000; this.buf = []; this.pos = 0; }
    process(inputs){
      const ch = inputs[0][0]; if (!ch) return true;
      for (; this.pos < ch.length; this.pos += this.ratio) {
        const s = Math.max(-1, Math.min(1, ch[Math.floor(this.pos)]));
        this.buf.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      }
      this.pos -= ch.length;
      if (this.buf.length >= 1600) { this.port.postMessage(Int16Array.from(this.buf).buffer, []); this.buf = []; }
      return true;
    }
  }
  registerProcessor('mlc-rec', Rec);`;

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
    s = { lang, cb, muted: false, handle: null, closing: false, reconnects: 0, playAt: 0, sources: new Set(), coachText: '', cancelled: new Set() };
    const me = s;
    cb.status?.('connecting');
    const tk = await fetchToken(lang);          // throws on auth / quota errors
    if (s !== me) return;
    s.token = tk.token; s.model = tk.model;

    // Audio graph
    // Output context first, with an inaudible "priming" sound playing BEFORE the mic opens: on Samsung Internet /
    // Chromium for Android, opening the mic while the page plays nothing switches the phone to the in-call
    // stream (loud, volume keys don't work) — this only happened on the first conversation after app start.
    s.outCtx = new AudioContext({ sampleRate: 24000 });
    await primeOutput(s.outCtx);
    if (s !== me) return;
    s.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    if (s !== me) { me.micStream.getTracks().forEach(t => t.stop()); return; }
    s.inCtx = new AudioContext();
    await s.inCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
    s.src = s.inCtx.createMediaStreamSource(s.micStream);
    s.node = new AudioWorkletNode(s.inCtx, 'mlc-rec');
    s.node.port.onmessage = e => {
      if (!s || s.muted || !s.ready || s.ws?.readyState !== 1) return;
      s.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(e.data), mimeType: 'audio/pcm;rate=16000' } } }));
    };
    s.src.connect(s.node);
    connect();
  }

  // Plays ~0.6 s of a 30 Hz tone at -50 dBFS (below what a phone speaker can reproduce) and waits 200 ms,
  // so the page already has active audio output when getUserMedia() is called.
  async function primeOutput(ctx) {
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      const n = Math.round(ctx.sampleRate * 0.6), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = 0.003 * Math.sin(2 * Math.PI * 30 * i / ctx.sampleRate) * Math.min(1, i / 1200, (n - i) / 1200);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
      await new Promise(r => setTimeout(r, 200));
    } catch {}
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
    if (sc.interrupted) flushPlayback();
    for (const p of sc.modelTurn?.parts || []) if (p.inlineData?.data) play(unb64(p.inlineData.data));
    if (sc.outputTranscription?.text) { s.coachText += sc.outputTranscription.text; s.cb.coach?.(s.coachText.trim()); }
    if (sc.inputTranscription?.text) s.cb.user?.(sc.inputTranscription.text);
    if (sc.turnComplete) s.coachText = '';
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

  function play(buf) {
    const ctx = s.outCtx, pcm = new Int16Array(buf), f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    const ab = ctx.createBuffer(1, f.length, 24000); ab.copyToChannel(f, 0);
    const src = ctx.createBufferSource(); src.buffer = ab; src.connect(ctx.destination);
    s.playAt = Math.max(s.playAt, ctx.currentTime + 0.03);
    src.start(s.playAt); s.playAt += ab.duration;
    s.sources.add(src); s.cb.speaking?.(true);
    src.onended = () => { s?.sources.delete(src); if (s && !s.sources.size) s.cb.speaking?.(false); };
  }
  function flushPlayback() {
    s.sources.forEach(x => { try { x.stop(); } catch {} }); s.sources.clear(); s.playAt = 0; s.cb.speaking?.(false);
  }

  function setMuted(m) { if (s) s.muted = m; }

  function stop() {
    const me = s; if (!me) return; s = null;
    me.closing = true;
    try { me.ws?.close(); } catch {}
    try { me.src?.disconnect(); me.node?.disconnect(); } catch {}
    me.micStream?.getTracks().forEach(t => t.stop());
    me.inCtx?.close().catch(() => {}); me.outCtx?.close().catch(() => {});
  }

  return { enabled, start, stop, setMuted, getPass, setPass, active: () => !!s };
})();
