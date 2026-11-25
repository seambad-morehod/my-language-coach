// My Language Coach — echo cancellation AudioWorklet (WebRTC AEC3, wasm; see aec3/SOURCE.txt).
// input 0 = microphone (opened WITHOUT browser echoCancellation → Android keeps the Media volume stream)
// input 1 = reference = exactly the audio sent to the speaker (Gemini's voice)
// Both are decimated to 16 kHz, AEC3 removes Gemini's voice from the mic, and 50 ms chunks of
// cleaned 16 kHz PCM are posted with their level, AEC3's voice-activity verdict and a voicing score
// (pitch periodicity 80–400 Hz: high for speech, low for coughs, sneezes, knocks and noise).
import { instantiate } from './aec3/index.js';

const RATE = 16000, FRAME = 160, CHUNK = 800;
const MINLAG = 40, MAXLAG = 200, WIN = 320;      // pitch 80–400 Hz; 20 ms analysis windows

// Voicing of one window: best normalised autocorrelation over pitch lags (0 = noise, ~1 = clearly voiced).
function voicing(x, start) {
  let e0 = 0; for (let i = start; i < start + WIN; i++) e0 += x[i] * x[i];
  if (e0 < 1e-7) return 0;
  let best = 0;
  for (let lag = MINLAG; lag <= MAXLAG; lag += 2) {
    let c = 0, e1 = 0;
    for (let i = start; i < start + WIN; i++) { const y = x[i + lag]; c += x[i] * y; e1 += y * y; }
    const r = c / Math.sqrt(e0 * e1 + 1e-12); if (r > best) best = r;
  }
  return best;
}

class MlcAec extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = Math.round(sampleRate / RATE);
    if (this.ratio * RATE !== sampleRate) throw new Error('unsupported sample rate ' + sampleRate);
    this.aec = instantiate(options.processorOptions.module).create({ sampleRate: RATE, noiseSuppression: 'moderate', vad: true });
    this.m = new Float32Array(FRAME); this.r = new Float32Array(FRAME); this.f = 0;
    this.am = 0; this.ar = 0; this.an = 0;
    this.out = new Float32Array(FRAME);
    this.buf = new Int16Array(CHUNK); this.n = 0; this.sq = 0; this.voice = 0; this.frames = 0;
    this.f32 = new Float32Array(CHUNK);
    this.busy = 0; this.t = 0;
  }
  process(inputs) {
    const mic = inputs[0][0]; if (!mic) return true;
    const ref = inputs[1] && inputs[1][0];
    const t0 = Date.now();
    for (let i = 0; i < mic.length; i++) {
      this.am += mic[i]; this.ar += ref ? ref[i] : 0;
      if (++this.an < this.ratio) continue;
      this.m[this.f] = this.am / this.an; this.r[this.f] = this.ar / this.an; this.am = this.ar = this.an = 0;
      if (++this.f < FRAME) continue;
      this.f = 0;
      const clean = this.aec.cancel(this.m, this.r, this.out);
      this.frames++; if (this.aec.stats().voice) this.voice++;
      for (let k = 0; k < FRAME; k++) {
        const v = Math.max(-1, Math.min(1, clean[k]));
        this.sq += v * v; this.f32[this.n] = v; this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      if (this.n === CHUNK) {
        // voicing: share of 20 ms windows in this 50 ms chunk that look like voiced speech (median-ish of 2 windows)
        const v1 = voicing(this.f32, 0), v2 = voicing(this.f32, CHUNK - WIN - MAXLAG);
        const msg = { pcm: this.buf.buffer, rms: Math.sqrt(this.sq / CHUNK), vad: this.voice / this.frames, voiced: Math.max(v1, v2) };
        if ((this.t += 50) >= 1000) { const st = this.aec.stats(); msg.stats = { erle: st.erleDb, delay: st.delayMs, cpu: this.busy / 10, errors: st.errors }; this.t = 0; this.busy = 0; }
        this.port.postMessage(msg, [this.buf.buffer]);
        this.buf = new Int16Array(CHUNK); this.n = 0; this.sq = 0; this.voice = 0; this.frames = 0;
      }
    }
    this.busy += Date.now() - t0;
    return true;
  }
}
registerProcessor('mlc-aec', MlcAec);
