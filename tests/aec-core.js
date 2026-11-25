// Acoustic echo canceller for My Language Coach (test 4).
// Partitioned-block frequency-domain adaptive filter (PBFDAF / MDF, as in Speex & WebRTC) +
// residual echo suppression. 16 kHz mono, block N = 256 samples (16 ms), filter length P·N.
// The far-end reference is the exact audio the app plays (Gemini's voice), so no browser
// echoCancellation is needed and Android keeps the Media volume stream.

function fft(re, im, inv) {            // in-place radix-2 complex FFT, length power of 2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const a = i + k, b = a + h;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

class AEC {
  constructor({ N = 256, P = 32, mu = 0.6 } = {}) {   // P·N = 8192 samples ≈ 512 ms of echo path
    this.N = N; this.P = P; this.M = 2 * N; this.K = N + 1; this.mu = mu;
    const z = () => new Float64Array(this.M);
    this.Xr = Array.from({ length: P }, z); this.Xi = Array.from({ length: P }, z);   // far-end spectra history
    this.Wr = Array.from({ length: P }, z); this.Wi = Array.from({ length: P }, z);   // filter
    this.xPrev = new Float64Array(N);
    this.pow = new Float64Array(this.M).fill(1e-6);       // smoothed far-end power per bin
    this.Se = new Float64Array(this.M); this.Sy = new Float64Array(this.M);   // for residual suppression
    this.tr = z(); this.ti = z(); this.er = z(); this.ei = z(); this.yr = z(); this.yi = z();
    this.blocks = 0; this.rr = 0;                          // round-robin index for gradient constraint
    this.erle = 0; this.farActive = false; this.delayMs = 0; this.nearHold = 0;
  }
  // x: far-end (what is being played), d: mic. Both Float32/64 arrays of length N. Returns cleaned Float32Array(N).
  process(x, d) {
    const { N, P, M, K } = this;
    // 1) spectrum of last 2N far-end samples, push into history
    const lastR = this.Xr.pop(), lastI = this.Xi.pop();
    for (let i = 0; i < N; i++) { lastR[i] = this.xPrev[i]; lastR[i + N] = x[i]; lastI[i] = 0; lastI[i + N] = 0; this.xPrev[i] = x[i]; }
    fft(lastR, lastI, false);
    this.Xr.unshift(lastR); this.Xi.unshift(lastI);
    let ex = 0; for (let i = 0; i < N; i++) ex += x[i] * x[i]; ex /= N;
    this.farActive = ex > 1e-6;
    for (let k = 0; k < M; k++) this.pow[k] = 0.92 * this.pow[k] + 0.08 * (lastR[k] * lastR[k] + lastI[k] * lastI[k]);
    // 2) echo estimate Y = Σ W_p X_p → y (last N samples of IFFT)
    const yr = this.yr, yi = this.yi; yr.fill(0); yi.fill(0);
    for (let p = 0; p < P; p++) {
      const Wr = this.Wr[p], Wi = this.Wi[p], Xr = this.Xr[p], Xi = this.Xi[p];
      for (let k = 0; k < M; k++) { yr[k] += Wr[k] * Xr[k] - Wi[k] * Xi[k]; yi[k] += Wr[k] * Xi[k] + Wi[k] * Xr[k]; }
    }
    const Yr = Float64Array.from(yr), Yi = Float64Array.from(yi);
    fft(yr, yi, true);
    const e = new Float64Array(N); let ed = 0, ee = 0, ey = 0;
    for (let i = 0; i < N; i++) { const y = yr[i + N]; e[i] = d[i] - y; ed += d[i] * d[i]; ee += e[i] * e[i]; ey += y * y; }
    ed /= N; ee /= N; ey /= N;
    // 3) ERLE while only Gemini is talking (diagnostic + double-talk guard)
    if (this.farActive && ed > 1e-7) { const r = 10 * Math.log10(ed / (ee + 1e-12)); this.erle = 0.95 * this.erle + 0.05 * Math.max(-10, Math.min(40, r)); }
    // double talk: once converged, a sudden error much larger than the echo estimate = user speaking → freeze
    const converged = this.erle > 6; this.converging = this.erle < 12;
    const doubleTalk = converged && ee > 2 * ey + 1e-6;
    if (doubleTalk) this.nearHold = 6; else if (this.nearHold > 0) this.nearHold--;
    // 4) NLMS update (error spectrum of [0…0, e])
    const er = this.er, ei = this.ei; er.fill(0); ei.fill(0);
    for (let i = 0; i < N; i++) er[i + N] = e[i];
    fft(er, ei, false);
    if (this.farActive && this.nearHold === 0) {
      const mu = this.converging ? this.mu : this.mu * 0.5;
      for (let p = 0; p < P; p++) {
        const Wr = this.Wr[p], Wi = this.Wi[p], Xr = this.Xr[p], Xi = this.Xi[p];
        for (let k = 0; k < M; k++) {
          const g = mu / (this.pow[k] * P + 1e-6);         // NLMS normalised by total far-end power over the filter
          Wr[k] += g * (Xr[k] * er[k] + Xi[k] * ei[k]); Wi[k] += g * (Xr[k] * ei[k] - Xi[k] * er[k]);
        }
      }
      // gradient constraint for one partition per block (keeps the filter causal / linear convolution)
      const p = this.rr = (this.rr + 1) % P, tr = this.tr, ti = this.ti;
      tr.set(this.Wr[p]); ti.set(this.Wi[p]); fft(tr, ti, true);
      for (let i = N; i < M; i++) { tr[i] = 0; ti[i] = 0; }
      fft(tr, ti, false); this.Wr[p].set(tr); this.Wi[p].set(ti);
    }
    // 5) residual echo suppression: per-bin Wiener-like gain on the error spectrum
    let maxE = 0, maxP = 0;
    if ((this.blocks++ & 15) === 0) for (let p = 0; p < P; p++) { let s = 0; const Wr = this.Wr[p], Wi = this.Wi[p]; for (let k = 0; k < K; k += 4) s += Wr[k] * Wr[k] + Wi[k] * Wi[k]; if (s > maxE) { maxE = s; maxP = p; } }
    if (maxE) this.delayMs = Math.round(maxP * N / 16);
    for (let k = 0; k < M; k++) {
      const se = er[k] * er[k] + ei[k] * ei[k], sy = Yr[k] * Yr[k] + Yi[k] * Yi[k];
      this.Se[k] = 0.7 * this.Se[k] + 0.3 * se; this.Sy[k] = 0.7 * this.Sy[k] + 0.3 * sy;
      const leak = converged ? 0.25 : 0.6;                       // assumed residual fraction of echo
      const g = this.farActive ? Math.max(0.08, 1 - leak * this.Sy[k] / (this.Se[k] + 1e-9)) : 1;
      er[k] *= g; ei[k] *= g;
    }
    fft(er, ei, true);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = Math.max(-1, Math.min(1, er[i + N]));
    return out;
  }
}
if (typeof module !== 'undefined') module.exports = { AEC, fft };
if (typeof globalThis !== 'undefined') globalThis.AEC = AEC;
