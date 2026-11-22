// mix-engine.js — Generate mix recommendations from analysis + roles.
//
// Philosophy (spec §4, §6):
//   MAIN       -> forward, clear mids
//   FOUNDATION -> stable, controlled low end
//   CONTOUR    -> defined highs, no harshness
//   SUPPORT    -> stay out of the MAIN's frequency lane
//
// Volume: each role has a target level relative to the loudest MAIN stem
// (the anchor). The fader move is target - measured LUFS, clamped to ±6 dB.

export const ROLE_TARGET_OFFSET = { MAIN: 0, FOUNDATION: -2, CONTOUR: -4, SUPPORT: -6 };
const MAX_VOLUME_MOVE_DB = 6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

function volumeRecommendations(stems) {
  const mains = stems.filter((s) => s.classification.role === 'MAIN');
  const pool = mains.length ? mains : stems;
  const anchor = Math.max(...pool.map((s) => s.analysis.integrated_lufs ?? -60));
  const out = {};
  for (const s of stems) {
    const lufs = s.analysis.integrated_lufs;
    if (lufs === null || lufs === undefined) { out[s.name] = 0; continue; }
    const target = anchor + ROLE_TARGET_OFFSET[s.classification.role];
    out[s.name] = r1(clamp(target - lufs, -MAX_VOLUME_MOVE_DB, MAX_VOLUME_MOVE_DB));
  }
  return { volumes: out, anchorLufs: anchor };
}

// ---------------------------------------------------------------------------
// EQ
// ---------------------------------------------------------------------------

function eqForStem(s, demo) {
  const { role, instrument } = s.classification;
  const band = s.analysis.band_energy;
  const eq = [];

  if (role === 'MAIN') {
    eq.push({ type: 'highpass', freq: instrument.includes('vocal') ? 80 : 60, slope: '12dB/oct' });
    if (band.low > 0.25) eq.push({ type: 'bell', freq: 250, gain: -2.0, q: 1.2, note: 'mud cleanup' });
    eq.push({ type: 'bell', freq: 3000, gain: 2.0, q: 1.0, note: 'presence' });
  } else if (role === 'FOUNDATION') {
    if (instrument === 'bass' || instrument === '808_bass') {
      eq.push({ type: 'bell', freq: 80, gain: 1.5, q: 1.0 });
      eq.push({ type: 'bell', freq: 300, gain: -1.5, q: 1.4, note: 'reduce boxiness' });
    } else if (instrument === 'kick') {
      eq.push({ type: 'bell', freq: 60, gain: 1.5, q: 1.0 });
      eq.push({ type: 'bell', freq: 400, gain: -2.0, q: 1.5, note: 'reduce boxiness' });
    } else {
      eq.push({ type: 'highpass', freq: 30, slope: '12dB/oct' });
      if (band.mid > 0.5) eq.push({ type: 'bell', freq: 500, gain: -1.5, q: 1.2 });
    }
  } else if (role === 'CONTOUR') {
    eq.push({ type: 'highpass', freq: 100, slope: '12dB/oct' });
    eq.push({ type: 'bell', freq: 3500, gain: -1.5, q: 2.0, note: 'harshness control — adjust by ear' });
    if (band.high < 0.15) eq.push({ type: 'high_shelf', freq: 8000, gain: 1.5 });
  } else {
    eq.push({ type: 'highpass', freq: 100, slope: '12dB/oct' });
    eq.push({ type: 'bell', freq: 2500, gain: -2.0, q: 1.2, note: 'carve space for MAIN mids' });
  }

  // Demo-informed tilt hints
  if (demo) {
    const d = demo.band_energy;
    if (d.high > 0.28 && (role === 'MAIN' || role === 'CONTOUR')) {
      eq.push({ type: 'high_shelf', freq: 10000, gain: 1.0, note: 'demo is bright — add air' });
    }
    if (d.low > 0.40 && role === 'FOUNDATION') {
      eq.push({ type: 'low_shelf', freq: 100, gain: 1.0, note: 'demo is bass-heavy — reinforce low end' });
    }
  }
  return eq;
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

const COMP = {
  vocal: { ratio: '3:1', attack_ms: 15, release_ms: 80, threshold_db: -18, makeup_gain_db: 1.5 },
  bass: { ratio: '4:1', attack_ms: 30, release_ms: 120, threshold_db: -20, makeup_gain_db: 1.0 },
  '808_bass': { ratio: '4:1', attack_ms: 30, release_ms: 120, threshold_db: -20, makeup_gain_db: 1.0 },
  kick: { ratio: '4:1', attack_ms: 10, release_ms: 100, threshold_db: -16, makeup_gain_db: 1.0 },
  drums: { ratio: '3:1', attack_ms: 20, release_ms: 150, threshold_db: -18, makeup_gain_db: 1.0 },
  _main: { ratio: '3:1', attack_ms: 15, release_ms: 100, threshold_db: -18, makeup_gain_db: 1.0 },
  _support: { ratio: '2:1', attack_ms: 25, release_ms: 150, threshold_db: -20, makeup_gain_db: 0.5 },
};

function compForStem(s) {
  const { instrument, role } = s.classification;
  const tr = s.analysis.transient_density;
  let preset;
  if (COMP[instrument]) preset = { ...COMP[instrument] };
  else if (role === 'MAIN') preset = { ...COMP._main };
  else if (role === 'SUPPORT' && tr < 0.2) return null; // steady pads rarely need it
  else preset = { ...COMP._support };
  if (tr > 0.6) preset.attack_ms = Math.max(preset.attack_ms, 20); // keep punch
  return preset;
}

// ---------------------------------------------------------------------------
// Pan & sends
// ---------------------------------------------------------------------------

const PAN = {
  vocal: 'C', backing_vocal: 'L20 / R20 (double)',
  bass: 'C', '808_bass': 'C', kick: 'C', snare: 'C',
  drums: 'C (bus) — keep kit image from source',
  cymbals: 'L30 / R30',
  lead_guitar: 'C or slight off-center (R10)',
  backing_guitar: 'L40 / R40 (if doubled)',
  backing: 'L40 / R40 (if doubled)',
  acoustic_guitar: 'L25', guitar: 'L30',
  piano: 'slight wide (L15–R15)', electric_piano: 'R20', organ: 'L20',
  synth_lead: 'C', synth: 'R25', pad: 'wide (L50–R50)', arp: 'L30',
  strings: 'wide (L40–R40)', brass: 'R20', percussion: 'R30', fx: 'wide',
};

const SEND_BASE = {
  MAIN: { reverb_send: 0.18, delay_send: 0.08 },
  FOUNDATION: { reverb_send: 0, delay_send: 0 },
  CONTOUR: { reverb_send: 0.10, delay_send: 0 },
  SUPPORT: { reverb_send: 0.15, delay_send: 0.05 },
};

function sendsForStem(s, demo) {
  const { role, instrument } = s.classification;
  if (['bass', 'kick', '808_bass'].includes(instrument)) return { reverb_send: 0, delay_send: 0 };
  // Wider demos allow more space; narrow demos keep it dry (spec §6.5)
  const width = demo ? demo.stereo_width : 0.5;
  const scale = clamp(0.6 + width * 0.8, 0.6, 1.4);
  const b = SEND_BASE[role];
  return { reverb_send: r2(b.reverb_send * scale), delay_send: r2(b.delay_send * scale) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {string} projectName
 * @param {{name:string, analysis:Object, classification:Object}[]} stems
 * @param {Object|null} demo  demo analysis report
 */
export function generateMixSettings(projectName, stems, demo) {
  const { volumes, anchorLufs } = volumeRecommendations(stems);
  const tracks = {};
  for (const s of stems) {
    const c = s.classification;
    const entry = {
      role: c.role,
      instrument: c.instrument,
      classification_confidence: c.confidence,
      volume_db: volumes[s.name],
      pan: PAN[c.instrument] || 'C',
      eq: eqForStem(s, demo),
    };
    if (c.secondary_role) entry.secondary_role = c.secondary_role;
    if (c.overridden) entry.role_overridden_by_user = true;
    const comp = compForStem(s);
    if (comp) entry.compressor = comp;
    Object.assign(entry, sendsForStem(s, demo));
    tracks[s.name] = entry;
  }

  const settings = {
    engine: 'Weno AutoMix Engine v0.1 (web)',
    project: projectName,
    volume_anchor_lufs: Number.isFinite(anchorLufs) ? r2(anchorLufs) : null,
    tracks,
  };
  if (demo) {
    settings.demo_reference = {
      integrated_lufs: demo.integrated_lufs,
      true_peak_dbtp: demo.true_peak_dbtp,
      spectral_balance: demo.band_energy,
      stereo_width: demo.stereo_width,
    };
  }
  return settings;
}
