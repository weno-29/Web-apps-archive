// report-writer.js — Serialize reports and produce Logic Pro notes text.

const EQ_LABEL = {
  highpass: 'HPF', lowpass: 'LPF', bell: 'Bell',
  high_shelf: 'High Shelf', low_shelf: 'Low Shelf',
};

const sign = (v) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
const pct = (v) => `${Math.round(v * 100)}%`;

export function formatEqBand(b) {
  const parts = [`${EQ_LABEL[b.type] || b.type} ${b.freq}Hz`];
  if (b.gain !== undefined) parts.push(`${sign(b.gain)}dB`);
  if (b.q !== undefined) parts.push(`Q${b.q}`);
  if (b.slope) parts.push(b.slope);
  let line = parts.join(' ');
  if (b.note) line += `   (${b.note})`;
  return line;
}

export function toJson(obj) {
  return JSON.stringify(obj, null, 2);
}

const ROLE_ORDER = { MAIN: 0, FOUNDATION: 1, CONTOUR: 2, SUPPORT: 3 };

export function sortedTracks(mixSettings) {
  return Object.entries(mixSettings.tracks).sort(
    ([an, a], [bn, b]) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || an.localeCompare(bn));
}

export function logicNotes(mix, generatedAt = new Date()) {
  const L = [];
  const hr = '-'.repeat(60);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${generatedAt.getFullYear()}-${pad(generatedAt.getMonth() + 1)}-${pad(generatedAt.getDate())} ${pad(generatedAt.getHours())}:${pad(generatedAt.getMinutes())}`;
  L.push('='.repeat(60));
  L.push('Weno AutoMix Engine v0.1 — Logic Pro Notes');
  L.push(`Project: ${mix.project}`);
  L.push(`Generated: ${stamp}`);
  L.push('='.repeat(60), '');

  const d = mix.demo_reference;
  if (d) {
    const sb = d.spectral_balance;
    L.push('[Demo Reference]');
    L.push(`  Integrated LUFS : ${d.integrated_lufs}`);
    L.push(`  True Peak       : ${d.true_peak_dbtp} dBTP`);
    L.push(`  Spectral Balance: Low ${pct(sb.low)} / Mid ${pct(sb.mid)} / High ${pct(sb.high)}`);
    L.push(`  Stereo Width    : ${d.stereo_width}`, '');
  }

  for (const [name, t] of sortedTracks(mix)) {
    const role = t.secondary_role ? `${t.role} / ${t.secondary_role}` : t.role;
    L.push(hr);
    L.push(`Track: ${name}`);
    L.push(`  Role      : ${role}  (instrument: ${t.instrument}, confidence: ${t.classification_confidence}${t.role_overridden_by_user ? ', set manually' : ''})`);
    L.push(`  Volume    : ${sign(t.volume_db)} dB`);
    L.push(`  Pan       : ${t.pan}`);
    if (t.eq?.length) {
      L.push('  EQ:');
      for (const b of t.eq) L.push(`    ${formatEqBand(b)}`);
    }
    const c = t.compressor;
    if (c) {
      L.push('  Compressor:');
      L.push(`    Ratio ${c.ratio}  Attack ${c.attack_ms}ms  Release ${c.release_ms}ms`);
      L.push(`    Threshold ${c.threshold_db}dB  Makeup ${sign(c.makeup_gain_db ?? 0)}dB`);
    } else {
      L.push('  Compressor: (not recommended for this source)');
    }
    L.push(`  Reverb Send: ${pct(t.reverb_send)}   Delay Send: ${pct(t.delay_send)}`, '');
  }

  L.push(hr);
  L.push('NOTE:');
  L.push('  * Volume values are relative moves from unity (0 dB fader).');
  L.push('  * All values are starting points — verify by ear against demo.wav.');
  L.push("  * Confidence 'low' means the stem filename was uninformative;");
  L.push('    double-check the role assignment.');
  return L.join('\n') + '\n';
}
