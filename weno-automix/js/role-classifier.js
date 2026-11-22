// role-classifier.js — Estimate instrument & mix role per stem.
//
// Stage 1: filename tokens (producers name their stems).
//          Specific rules come before generic ones so that e.g.
//          "backing_vocal" is not caught by "vocal", "kick/bassdrum" not by
//          "bass", and "epiano" not by "piano".
// Stage 2: acoustic-feature fallback (centroid, band energy, transients).
//
// Roles: MAIN / FOUNDATION / CONTOUR / SUPPORT (spec §4).

export const ROLES = ['MAIN', 'FOUNDATION', 'CONTOUR', 'SUPPORT'];

export const ROLE_LABEL_JA = {
  MAIN: '主役',
  FOUNDATION: '土台',
  CONTOUR: '輪郭',
  SUPPORT: '補助',
};

// Each rule: [instrument, role, secondaryRole, {tok:[exact tokens], inc:[substrings]}]
const RULES = [
  ['backing_vocal', 'SUPPORT', null, { tok: ['cho', 'bgv', 'bv', 'harmony', 'harmonies', 'chorus', 'choir'], inc: ['backingvo', 'backvo', 'harmon', 'chorus', 'コーラス'] }],
  ['vocal', 'MAIN', null, { tok: ['vo', 'vox', 'vocal', 'vocals', 'voice', 'vo1', 'leadvo'], inc: ['vocal', 'voice', 'vox', '歌', 'ボーカル', 'ボーカル'] }],
  ['lead_guitar', 'MAIN', 'CONTOUR', { inc: ['leadg', 'leadgt', 'sologt', 'sologuitar', 'gtlead', 'gtsolo', 'guitarsolo', 'guitarlead', 'リードギター', 'ギターリード', 'ギターソロ'] }],
  ['backing_guitar', 'SUPPORT', null, { inc: ['backinggt', 'backgt', 'backingguitar', 'backguitar', 'rhythmg', 'gtback', 'gtrhythm', 'guitarrhythm', 'バッキング'] }],
  ['acoustic_guitar', 'SUPPORT', null, { tok: ['ag', 'agt', 'acg'], inc: ['acoustic', 'acogt', 'acoguitar', 'アコギ'] }],
  ['guitar', 'SUPPORT', 'CONTOUR', { tok: ['gt', 'gtr', 'eg', 'egt'], inc: ['guitar', 'ギター'] }],
  ['kick', 'FOUNDATION', null, { tok: ['bd', 'kik', 'kck'], inc: ['kick', 'bassdrum', 'キック'] }],
  ['808_bass', 'FOUNDATION', null, { inc: ['808'] }],
  ['bass', 'FOUNDATION', null, { tok: ['ba', 'bs', 'bss'], inc: ['bass', 'ベース'] }],
  ['snare', 'CONTOUR', null, { tok: ['sn', 'sd', 'snr'], inc: ['snare', 'スネア'] }],
  ['cymbals', 'CONTOUR', null, { tok: ['hh', 'oh', 'oh1', 'oh2'], inc: ['hihat', 'hat', 'cymbal', 'ride', 'crash', 'overhead', 'ハイハット'] }],
  ['drums', 'FOUNDATION', 'CONTOUR', { tok: ['dr', 'drs', 'kit'], inc: ['drum', 'ドラム', 'beat'] }],
  ['percussion', 'CONTOUR', null, { tok: ['perc'], inc: ['perc', 'shaker', 'tamb', 'conga', 'bongo', 'clap'] }],
  ['electric_piano', 'SUPPORT', null, { tok: ['ep', 'epno'], inc: ['epiano', 'elpiano', 'electricpiano', 'rhodes', 'wurli'] }],
  ['synth_lead', 'MAIN', 'CONTOUR', { inc: ['synthlead', 'leadsynth', 'leadsyn', 'synlead'] }],
  ['piano', 'MAIN', 'SUPPORT', { tok: ['pf', 'pno', 'key', 'keys', 'kb'], inc: ['piano', 'ピアノ', 'keyboard'] }],
  ['organ', 'SUPPORT', null, { inc: ['organ', 'オルガン'] }],
  ['pad', 'SUPPORT', null, { inc: ['pad', 'パッド'] }],
  ['arp', 'CONTOUR', null, { inc: ['arp'] }],
  ['synth', 'SUPPORT', null, { tok: ['syn', 'syn1', 'syn2'], inc: ['synth', 'シンセ'] }],
  ['strings', 'SUPPORT', null, { tok: ['str', 'strs'], inc: ['string', 'violin', 'viola', 'cello', 'vln', 'ストリングス'] }],
  ['brass', 'CONTOUR', null, { inc: ['brass', 'horn', 'sax', 'trumpet', 'trombone'] }],
  ['fx', 'SUPPORT', null, { tok: ['fx', 'sfx'], inc: ['riser', 'sweep', 'noise', 'impact'] }],
];

// Generic names from the spec's example layout (e.g. backing.wav) — medium confidence
const GENERIC = [
  ['backing', 'SUPPORT', null, { tok: ['backing', 'back', 'bk'] }],
];

function tokenize(filename) {
  const base = filename.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  // split camelCase-free lowercase names on anything that is not a letter/number/CJK
  const tokens = base.split(/[^a-z0-9぀-ヿ一-鿿]+/).filter(Boolean);
  // also split leading track numbers: "01vocal" -> "vocal"
  const extra = tokens.map((t) => t.replace(/^\d+/, '')).filter((t) => t && !tokens.includes(t));
  const all = [...tokens, ...extra];
  return { tokens: new Set(all), joined: all.join('') };
}

function matchRules(rules, { tokens, joined }) {
  for (const [instrument, role, secondary, m] of rules) {
    const hitTok = (m.tok || []).some((t) => tokens.has(t));
    const hitInc = (m.inc || []).some((s) => joined.includes(s));
    if (hitTok || hitInc) return { instrument, role, secondary };
  }
  return null;
}

function classifyByFeatures(a) {
  const { low = 0, mid = 0, high = 0 } = a.band_energy || {};
  const c = a.spectral_centroid_hz || 0;
  const t = a.transient_density || 0;
  if (low > 0.6 && c < 400) return { instrument: 'unknown_low', role: 'FOUNDATION', secondary: null };
  if (t > 0.6 && high > 0.25) return { instrument: 'unknown_percussive', role: 'CONTOUR', secondary: null };
  if (mid > 0.55 && c >= 500 && c <= 3000) return { instrument: 'unknown_melodic', role: 'MAIN', secondary: null };
  return { instrument: 'unknown', role: 'SUPPORT', secondary: null };
}

/**
 * @returns {{instrument:string, role:string, secondary_role:string|null,
 *            method:string, confidence:'high'|'medium'|'low'}}
 */
export function classify(filename, analysis) {
  const tk = tokenize(filename);
  let r = matchRules(RULES, tk);
  if (r) return { instrument: r.instrument, role: r.role, secondary_role: r.secondary, method: 'filename', confidence: 'high' };
  r = matchRules(GENERIC, tk);
  if (r) return { instrument: r.instrument, role: r.role, secondary_role: r.secondary, method: 'filename_generic', confidence: 'medium' };
  r = classifyByFeatures(analysis);
  return { instrument: r.instrument, role: r.role, secondary_role: r.secondary, method: 'acoustic_features', confidence: 'low' };
}
