// analyzer.js — Loudness / spectral / dynamics analysis (pure JS, no DOM).
//
// LUFS follows ITU-R BS.1770-4:
//   K-weighting = stage-1 high shelf + stage-2 RLB high-pass, with biquad
//   coefficients derived analytically for any sample rate.
//   Integrated: 400 ms blocks, 75 % overlap, absolute gate -70 LUFS,
//   relative gate -10 LU. Short-term: 3 s windows, 1 s hop.
// True Peak: 4x oversampling with a windowed-sinc polyphase interpolator,
//   evaluated around loud samples only (inter-sample overs occur there).

// ---------------------------------------------------------------------------
// Small DSP helpers
// ---------------------------------------------------------------------------

/** Biquad, Direct Form II transposed. Returns Float64Array. */
function biquad(b, a, x) {
  const y = new Float64Array(x.length);
  const [b0, b1, b2] = b;
  const [, a1, a2] = a;
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + z1;
    z1 = b1 * xi - a1 * yi + z2;
    z2 = b2 * xi - a2 * yi;
    y[i] = yi;
  }
  return y;
}

/** In-place iterative radix-2 complex FFT. re/im lengths must be a power of two. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k + half], ai = im[i + k + half];
        const tr = ar * cr - ai * ci;
        const ti = ar * ci + ai * cr;
        re[i + k + half] = re[i + k] - tr;
        im[i + k + half] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const hannCache = new Map();
function hann(n) {
  if (!hannCache.has(n)) {
    const w = new Float64Array(n);
    // periodic Hann (matches scipy.signal.get_window('hann'))
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    hannCache.set(n, w);
  }
  return hannCache.get(n);
}

/**
 * Iterate STFT magnitude-squared frames. callback(powerSpectrum Float64Array[n/2+1]).
 */
function stftFrames(x, nFft, hop, callback) {
  const w = hann(nFft);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  const nBins = nFft / 2 + 1;
  const pw = new Float64Array(nBins);
  // Match scipy.signal.stft defaults: boundary='zeros' (nFft/2 zeros on both
  // ends) and padded=True (zero-fill the last partial frame).
  const padL = nFft >> 1;
  const total = x.length + 2 * padL;
  const nFrames = Math.max(1, Math.ceil((total - nFft) / hop) + 1);
  for (let f = 0; f < nFrames; f++) {
    const start = f * hop - padL;
    for (let i = 0; i < nFft; i++) {
      const idx = start + i;
      const s = idx >= 0 && idx < x.length ? x[idx] : 0;
      re[i] = s * w[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < nBins; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
    callback(pw, f);
  }
  return nFrames;
}

function mono(channels) {
  const n = channels[0].length;
  const out = new Float64Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const inv = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= inv;
  return out;
}

const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// ---------------------------------------------------------------------------
// K-weighting & loudness
// ---------------------------------------------------------------------------

export function kWeightingCoeffs(fs) {
  // Stage 1: spherical-head high shelf
  let f0 = 1681.9744509555319;
  const G = 3.99984385397;
  let Q = 0.7071752369554193;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.499666774155;
  let a0 = 1 + K / Q + K * K;
  const b1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0];
  const a1 = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];

  // Stage 2: RLB high-pass
  f0 = 38.13547087613982;
  Q = 0.5003270373253953;
  K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const b2 = [1 / a0, -2 / a0, 1 / a0];
  const a2 = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  return { b1, a1, b2, a2 };
}

const CHANNEL_WEIGHTS = [1, 1, 1, 1.41, 1.41]; // L R C Ls Rs

/** Prefix sums of K-weighted squared samples, per channel. */
function kWeightedEnergy(channels, fs) {
  const { b1, a1, b2, a2 } = kWeightingCoeffs(fs);
  return channels.map((ch) => {
    const y = biquad(b2, a2, biquad(b1, a1, ch));
    const cs = new Float64Array(y.length + 1);
    for (let i = 0; i < y.length; i++) cs[i + 1] = cs[i] + y[i] * y[i];
    return cs;
  });
}

function blockLoudness(prefix, fs, blockSec, hopSec) {
  const n = prefix[0].length - 1;
  const block = Math.round(blockSec * fs);
  const hop = Math.round(hopSec * fs);
  const weights = prefix.length <= 5 ? CHANNEL_WEIGHTS : prefix.map(() => 1);
  // Short files are treated as one block padded with silence
  const nBlocks = n < block ? 1 : 1 + Math.floor((n - block) / hop);
  const times = new Float64Array(nBlocks);
  const loud = new Float64Array(nBlocks);
  for (let i = 0; i < nBlocks; i++) {
    const s = i * hop;
    const e = Math.min(s + block, n);
    let power = 0;
    prefix.forEach((cs, c) => { power += weights[c] * (cs[e] - cs[s]) / block; });
    loud[i] = power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity;
    times[i] = s / fs;
  }
  return { times, loud };
}

function integratedFromBlocks(blocks) {
  const meanPow = (arr) => arr.reduce((acc, l) => acc + 10 ** ((l + 0.691) / 10), 0) / arr.length;
  let gated = Array.from(blocks).filter((l) => l > -70);
  if (!gated.length) return -Infinity;
  const rel = 10 * Math.log10(meanPow(gated)) - 0.691 - 10;
  gated = gated.filter((l) => l > rel);
  if (!gated.length) return -Infinity;
  return 10 * Math.log10(meanPow(gated)) - 0.691;
}

// ---------------------------------------------------------------------------
// Peak measures
// ---------------------------------------------------------------------------

const OS = 4;            // oversampling factor
const TAPS_PER_PHASE = 32;
let polyphase = null;
function getPolyphase() {
  if (polyphase) return polyphase;
  // Windowed-sinc (Kaiser beta=8) low-pass at Nyquist of the original rate
  const L = OS * TAPS_PER_PHASE;
  const h = new Float64Array(L);
  const center = (L - 1) / 2;
  const beta = 8;
  const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
  for (let i = 0; i < L; i++) {
    const m = i - center;
    const sinc = m === 0 ? 1 : Math.sin(Math.PI * m / OS) / (Math.PI * m / OS);
    const r = (2 * i) / (L - 1) - 1;
    h[i] = sinc * i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0(beta);
  }
  polyphase = Array.from({ length: OS }, (_, p) => {
    const taps = new Float64Array(TAPS_PER_PHASE);
    for (let k = 0; k < TAPS_PER_PHASE; k++) taps[k] = h[k * OS + p];
    return taps;
  });
  return polyphase;
}

function samplePeak(channels) {
  let p = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > p) p = a; }
  return p;
}

/**
 * 4x-oversampled true peak, two passes:
 *   1. cheap cubic (Catmull-Rom) estimate on every interval near the peak
 *      level, to find candidate regions;
 *   2. the full windowed-sinc interpolator only on candidates whose cheap
 *      estimate is within 2 dB of the best one (cubic underestimates the
 *      ringing of band-limited reconstruction, so the margin is generous).
 */
export function truePeak(channels) {
  const sp = samplePeak(channels);
  if (sp <= 0) return 0;
  const thresh = sp * 0.5; // intervals with both samples >6 dB below peak are skipped

  // pass 1 — cubic estimate per interval
  const cands = [];
  let bestEst = sp;
  for (let c = 0; c < channels.length; c++) {
    const x = channels[c];
    const n = x.length;
    for (let i = 1; i < n - 2; i++) {
      const x1 = x[i], x2 = x[i + 1];
      if (Math.abs(x1) < thresh && Math.abs(x2) < thresh) continue;
      const x0 = x[i - 1], x3 = x[i + 2];
      let est = 0;
      for (let p = 1; p < OS; p++) {
        const t = p / OS, t2 = t * t, t3 = t2 * t;
        const v = 0.5 * ((2 * x1) + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3);
        const a = Math.abs(v);
        if (a > est) est = a;
      }
      est = Math.max(est, Math.abs(x1), Math.abs(x2));
      if (est > bestEst) bestEst = est;
      cands.push(c, i, est);
    }
  }

  // pass 2 — precise interpolation on the strongest candidates
  const phases = getPolyphase();
  const half = TAPS_PER_PHASE >> 1;
  const cut = bestEst * 0.794; // -2 dB
  let tp = sp;
  for (let j = 0; j < cands.length; j += 3) {
    if (cands[j + 2] < cut) continue;
    const x = channels[cands[j]];
    const n = x.length;
    const i = cands[j + 1];
    // output points between samples i and i+1 come from bases near i+half
    for (let base = i; base <= i; base++) {
      for (let p = 0; p < OS; p++) {
        const taps = phases[p];
        let acc = 0;
        for (let k = 0; k < TAPS_PER_PHASE; k++) {
          const idx = base - k + half;
          if (idx >= 0 && idx < n) acc += taps[k] * x[idx];
        }
        const a = Math.abs(acc);
        if (a > tp) tp = a;
      }
    }
  }
  return tp;
}

// ---------------------------------------------------------------------------
// Spectral features
// ---------------------------------------------------------------------------

export const BANDS = { low: [20, 250], mid: [250, 4000], high: [4000, 20000] };

function meanSpectrum(m, fs, nFft = 4096) {
  const nBins = nFft / 2 + 1;
  const acc = new Float64Array(nBins);
  const nFrames = stftFrames(m, nFft, nFft / 2, (pw) => {
    for (let k = 0; k < nBins; k++) acc[k] += pw[k];
  });
  for (let k = 0; k < nBins; k++) acc[k] /= nFrames;
  const freqs = new Float64Array(nBins);
  for (let k = 0; k < nBins; k++) freqs[k] = (k * fs) / nFft;
  return { freqs, power: acc };
}

function spectralFeatures(spec) {
  const { freqs, power } = spec;
  let total = 0, weighted = 0;
  for (let k = 0; k < power.length; k++) { total += power[k]; weighted += freqs[k] * power[k]; }
  if (total <= 0) return { centroid: 0, band: { low: 0, mid: 0, high: 0 } };
  const ratio = ([lo, hi]) => {
    let s = 0;
    for (let k = 0; k < power.length; k++) if (freqs[k] >= lo && freqs[k] < hi) s += power[k];
    return s / total;
  };
  return {
    centroid: weighted / total,
    band: { low: ratio(BANDS.low), mid: ratio(BANDS.mid), high: ratio(BANDS.high) },
  };
}

/** Onset density from positive spectral flux; ~8 onsets/s maps to 1.0. */
function transientDensity(m, fs) {
  const nFft = 1024, hop = 512;
  const nBins = nFft / 2 + 1;
  let prev = null;
  const flux = [];
  stftFrames(m, nFft, hop, (pw) => {
    const mag = new Float64Array(nBins);
    for (let k = 0; k < nBins; k++) mag[k] = Math.sqrt(pw[k]);
    if (prev) {
      let s = 0;
      for (let k = 0; k < nBins; k++) { const d = mag[k] - prev[k]; if (d > 0) s += d; }
      flux.push(s);
    }
    prev = mag;
  });
  if (!flux.length) return 0;
  const max = Math.max(...flux);
  if (max <= 0) return 0;
  const f = flux.map((v) => v / max);
  const mean = f.reduce((a, b) => a + b, 0) / f.length;
  const std = Math.sqrt(f.reduce((a, b) => a + (b - mean) ** 2, 0) / f.length);
  const th = mean + std;
  let onsets = 0;
  for (let i = 1; i < f.length; i++) if (f[i] > th && f[i] > f[i - 1]) onsets++;
  const perSec = onsets / Math.max(m.length / fs, 1e-9);
  return Math.min(perSec / 8, 1);
}

function stereoWidth(channels) {
  if (channels.length < 2) return 0;
  const [L, R] = channels;
  let mid = 0, side = 0;
  for (let i = 0; i < L.length; i++) {
    const mm = (L[i] + R[i]) * 0.5, ss = (L[i] - R[i]) * 0.5;
    mid += mm * mm; side += ss * ss;
  }
  return mid > 0 ? Math.sqrt(side / mid) : 0;
}

/** Cosine similarity of two mean power spectra (0..1). */
export function spectralOverlap(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let k = 0; k < n; k++) { dot += a[k] * b[k]; na += a[k] * a[k]; nb += b[k] * b[k]; }
  return na > 0 && nb > 0 ? round(dot / Math.sqrt(na * nb), 4) : 0;
}

// ---------------------------------------------------------------------------
// Section estimation (heuristic, demo only)
// ---------------------------------------------------------------------------

function estimateSections(envelope, integrated) {
  // Label each 2 s window relative to integrated loudness, then merge runs.
  const label = (l) => {
    if (l === null) return 'silence';
    if (l >= integrated + 1.5) return 'high';
    if (l <= integrated - 4) return 'low';
    return 'mid';
  };
  const segs = [];
  for (const pt of envelope) {
    const lab = label(pt.short_term_lufs);
    const last = segs[segs.length - 1];
    if (last && last.energy === lab) last.end_sec = pt.time_sec + 2;
    else segs.push({ start_sec: pt.time_sec, end_sec: pt.time_sec + 2, energy: lab });
  }
  // absorb 1-window blips into neighbours
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s.end_sec - s.start_sec <= 2 && merged.length) { last.end_sec = s.end_sec; continue; }
    if (last && last.energy === s.energy) { last.end_sec = s.end_sec; continue; }
    merged.push({ ...s });
  }
  const hint = { high: 'サビ候補', mid: 'verse候補', low: 'イントロ/ブレイク候補', silence: '無音' };
  return merged.map((s) => ({ ...s, hint: hint[s.energy] }));
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Analyze one decoded file.
 * @param {{name:string, sampleRate:number, channels:Float32Array[]}} audio
 * @param {{isDemo?:boolean}} opts
 * @returns {{report:Object, spectrum:Float64Array}}
 */
export function analyzeAudio(audio, opts = {}) {
  const { name, sampleRate: fs, channels } = audio;
  const n = channels[0].length;
  const m = mono(channels);

  const prefix = kWeightedEnergy(channels, fs);
  const mom = blockLoudness(prefix, fs, 0.4, 0.1);
  const integrated = integratedFromBlocks(mom.loud);
  const st = blockLoudness(prefix, fs, 3.0, 1.0);
  let stMax = -Infinity;
  for (const v of st.loud) if (v > stMax) stMax = v;

  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += m[i] * m[i];

  const spec = meanSpectrum(m, fs);
  const feats = spectralFeatures(spec);

  const report = {
    file: name,
    duration_sec: round(n / fs, 2),
    sample_rate: fs,
    channels: channels.length,
    integrated_lufs: round(integrated),
    short_term_lufs_max: round(stMax),
    true_peak_dbtp: round(db(truePeak(channels))),
    sample_peak_db: round(db(samplePeak(channels))),
    rms_db: round(db(Math.sqrt(sumSq / n))),
    spectral_centroid_hz: round(feats.centroid, 1),
    band_energy: {
      low: round(feats.band.low, 4),
      mid: round(feats.band.mid, 4),
      high: round(feats.band.high, 4),
    },
    transient_density: round(transientDensity(m, fs), 3),
    stereo_width: round(stereoWidth(channels), 3),
  };

  if (opts.isDemo) {
    const env = blockLoudness(prefix, fs, 2.0, 2.0);
    const envelope = [];
    env.times.forEach((t, i) => {
      if (Number.isFinite(env.loud[i])) {
        envelope.push({ time_sec: round(t, 1), short_term_lufs: round(env.loud[i]) });
      }
    });
    report.loudness_envelope_2s = envelope;
    if (Number.isFinite(integrated)) {
      report.estimated_sections = estimateSections(envelope, integrated);
    }
  }

  return { report, spectrum: spec.power };
}
