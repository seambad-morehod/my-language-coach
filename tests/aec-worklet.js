// Test 4 — AudioWorklet: WebRTC AEC3 (wasm) cancels Gemini's voice from the microphone.
// input 0 = microphone (no browser echoCancellation → Android keeps the Media stream)
// input 1 = reference = exactly what is sent to the speaker
// Posts 50 ms chunks of cleaned 16 kHz PCM + level + VAD + stats to the main thread.
import { instantiate } from './aec3/index.js';

class MlcAec extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.aec = instantiate(options.processorOptions.module).create({ sampleRate, noiseSuppression: 'moderate', vad: true });
    this.ratio = sampleRate / 16000;                 // 3 at 48 kHz, 1 at 16 kHz
    this.out = new Float32Array(128); this.zero = new Float32Array(128);
    this.acc = 0; this.accN = 0;
    this.buf = new Int16Array(800); this.n = 0; this.sq = 0; this.voice = 0; this.frames = 0;
    this.busy = 0; this.t = 0; this.q = 0;
  }
  process(inputs) {
    const mic = inputs[0][0]; if (!mic) return true;
    const ref = (inputs[1] && inputs[1][0]) || this.zero;
    const t0 = Date.now();
    const clean = this.aec.cancel(mic, ref, this.out);
    if ((++this.q & 3) === 0) { const st = this.aec.stats(); this.frames++; if (st.voice) this.voice++; }
    for (let i = 0; i < clean.length; i++) {
      this.acc += clean[i]; if (++this.accN < this.ratio) continue;
      const v = Math.max(-1, Math.min(1, this.acc / this.accN)); this.acc = 0; this.accN = 0;
      this.sq += v * v; this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === 800) {
        const msg = { pcm: this.buf.buffer, rms: Math.sqrt(this.sq / 800), vad: this.frames ? this.voice / this.frames : 0 };
        if ((this.t += 50) >= 1000) { const st = this.aec.stats(); msg.stats = { erle: st.erleDb, delay: st.delayMs, cpu: this.busy / 10, errors: st.errors }; this.t = 0; this.busy = 0; }
        this.port.postMessage(msg, [this.buf.buffer]);
        this.buf = new Int16Array(800); this.n = 0; this.sq = 0; this.voice = 0; this.frames = 0;
      }
    }
    this.busy += Date.now() - t0;
    return true;
  }
}
registerProcessor('mlc-aec', MlcAec);
