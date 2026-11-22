// sample.js — Synthetic demo + stems so the app can be tried without audio files.
import { encodeWav16 } from './audio-loader.js';

function rng(seed) { // mulberry32
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSampleProject() {
  const SR = 44100, DUR = 12, N = SR * DUR;
  const rand = rng(29);
  const gauss = () => { const u = rand() || 1e-9, v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const sin = (f, t) => Math.sin(2 * Math.PI * f * t);

  const vocal = new Float32Array(N), bass = new Float32Array(N), drums = new Float32Array(N);
  const pianoL = new Float32Array(N), pianoR = new Float32Array(N);
  const padL = new Float32Array(N), padR = new Float32Array(N);
  const lead = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const t = i / SR;
    // vocal enters at 2 s, louder "chorus" 6–10 s
    const vAmp = t < 2 ? 0 : t >= 6 && t < 10 ? 0.5 : 0.3;
    vocal[i] = vAmp * (sin(440, t) * (1 + 0.3 * sin(5, t)) + 0.25 * sin(880, t) + 0.1 * sin(2640, t));
    bass[i] = 0.5 * sin(82, t) * (0.5 + 0.5 * Math.sign(sin(2, t)));
    const pAmp = 0.22 * (0.6 + 0.4 * sin(0.5, t));
    pianoL[i] = pAmp * (sin(523, t) + sin(659, t));
    pianoR[i] = pianoL[i] * 0.85;
    const pd = 0.12 * (sin(330, t) + sin(415, t)) + 0.01 * gauss();
    padL[i] = pd; padR[i] = 0.12 * (sin(331, t) + sin(414, t)) + 0.01 * gauss();
    lead[i] = t >= 10 ? 0.3 * (sin(1320, t) + 0.4 * sin(2640, t)) : 0;
  }
  const hit = Math.round(0.05 * SR);
  for (let b = 0; b < DUR; b += 0.5) {
    const s = Math.round(b * SR);
    const snare = Math.round(b * 2) % 2 === 1;
    for (let k = 0; k < hit && s + k < N; k++) {
      const tk = k / SR;
      drums[s + k] += 0.9 * sin(60, tk) * Math.exp(-tk * 60);
      if (snare) drums[s + k] += 0.3 * gauss() * Math.exp(-tk * 80);
      drums[s + k] += 0.05 * gauss() * Math.exp(-tk * 300); // hat-ish tick
    }
  }

  // demo = rough reference mix
  const dL = new Float32Array(N), dR = new Float32Array(N);
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const c = vocal[i] + 0.8 * bass[i] + drums[i] + 0.8 * lead[i];
    dL[i] = c + 0.6 * pianoL[i] + 0.6 * padL[i];
    dR[i] = c + 0.6 * pianoR[i] + 0.6 * padR[i];
    peak = Math.max(peak, Math.abs(dL[i]), Math.abs(dR[i]));
  }
  const g = 0.9 / peak;
  for (let i = 0; i < N; i++) { dL[i] *= g; dR[i] *= g; }

  const file = (name, chans) => new File([encodeWav16(chans, SR)], name, { type: 'audio/wav' });
  return {
    demo: file('demo.wav', [dL, dR]),
    stems: [
      file('vocal.wav', [vocal]),
      file('bass.wav', [bass]),
      file('drums.wav', [drums]),
      file('piano.wav', [pianoL, pianoR]),
      file('pad.wav', [padL, padR]),
      file('Lead Gt.wav', [lead]),
      file('Audio 07.wav', [new Float32Array(N).map((_, i) => 0.2 * sin(1200, i / SR))]),
    ],
  };
}
