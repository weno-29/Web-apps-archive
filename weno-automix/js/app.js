// app.js — UI wiring for Weno AutoMix Engine (web).
import { decodeFile } from './audio-loader.js';
import { spectralOverlap } from './analyzer.js';
import { classify, ROLES, ROLE_LABEL_JA } from './role-classifier.js';
import { generateMixSettings } from './mix-engine.js';
import { toJson, logicNotes, formatEqBand, sortedTracks } from './report-writer.js';
import { makeSampleProject } from './sample.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AUDIO_EXT = /\.(wav|wave|aif|aiff|flac|mp3|m4a|aac|ogg|caf)$/i;

const state = {
  demoFile: null,
  stemFiles: [],
  demo: null,         // { report, spectrum }
  stems: [],          // { name, analysis, spectrum, classification, autoClassification }
  overlaps: {},
  outputs: null,      // { 'analysis_report.json': str, ... }
};

// ---------------------------------------------------------------------------
// File inputs
// ---------------------------------------------------------------------------

function bindDrop(dropId, inputId, onFiles) {
  const drop = $(dropId), input = $(inputId);
  drop.addEventListener('click', (e) => { if (!e.target.closest('button')) input.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { onFiles([...input.files]); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    onFiles([...e.dataTransfer.files]);
  });
}

function addStems(files) {
  for (const f of files) {
    if (!AUDIO_EXT.test(f.name) && !f.type.startsWith('audio/')) continue;
    const i = state.stemFiles.findIndex((s) => s.name === f.name);
    if (i >= 0) state.stemFiles[i] = f; else state.stemFiles.push(f);
  }
  renderFileLists();
}

function setDemo(files) {
  const f = files.find((x) => AUDIO_EXT.test(x.name) || x.type.startsWith('audio/'));
  if (f) state.demoFile = f;
  renderFileLists();
}

function fmtSize(b) { return b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`; }

function renderFileLists() {
  $('demo-list').innerHTML = state.demoFile
    ? `<li><span>${esc(state.demoFile.name)} · ${fmtSize(state.demoFile.size)}</span><button type="button" data-rm="demo" aria-label="削除">×</button></li>`
    : '';
  $('stems-list').innerHTML = state.stemFiles.map((f, i) =>
    `<li><span>${esc(f.name)} · ${fmtSize(f.size)}</span><button type="button" data-rm="${i}" aria-label="削除">×</button></li>`).join('');
  $('analyze-btn').disabled = state.stemFiles.length === 0;
}

document.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (!rm) return;
  e.stopPropagation();
  if (rm.dataset.rm === 'demo') state.demoFile = null;
  else state.stemFiles.splice(Number(rm.dataset.rm), 1);
  renderFileLists();
});

// ---------------------------------------------------------------------------
// Analysis (worker with main-thread fallback)
// ---------------------------------------------------------------------------

let worker = null;
let msgId = 0;
const pending = new Map();

function getWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.ok ? p.resolve(e.data) : p.reject(new Error(e.data.error));
    };
    worker.onerror = () => {
      // module workers unsupported / failed to load -> reject and fall back
      worker = false;
      for (const p of pending.values()) p.reject(new Error('worker unavailable'));
      pending.clear();
    };
  } catch {
    worker = false;
  }
  return worker;
}

async function analyzeDecoded(decoded, isDemo) {
  const w = getWorker();
  if (w) {
    try {
      return await new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        // copy channels so the decoded buffers stay usable if we need a fallback
        const channels = decoded.channels.map((c) => c.slice());
        w.postMessage({ id, name: decoded.name, sampleRate: decoded.sampleRate, channels, isDemo },
          channels.map((c) => c.buffer));
      });
    } catch (err) {
      if (worker) throw err; // real analysis error
      // worker failed to start -> fall through to main thread
    }
  }
  const { analyzeAudio } = await import('./analyzer.js');
  await new Promise((r) => setTimeout(r, 0));
  return analyzeAudio(decoded, { isDemo });
}

function setProgress(done, total, label) {
  $('progress').hidden = false;
  $('progress-bar').style.width = `${Math.round((done / total) * 100)}%`;
  $('progress-text').textContent = label;
}

function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.hidden = !msg;
}

async function runAnalysis() {
  showError('');
  $('analyze-btn').disabled = true;
  const jobs = [];
  if (state.demoFile) jobs.push({ file: state.demoFile, isDemo: true });
  for (const f of state.stemFiles) jobs.push({ file: f, isDemo: false });

  const errors = [];
  let demo = null;
  const stems = [];
  const t0 = performance.now();

  for (let i = 0; i < jobs.length; i++) {
    const { file, isDemo } = jobs[i];
    setProgress(i, jobs.length, `解析中 ${i + 1}/${jobs.length}: ${file.name}`);
    try {
      const decoded = await decodeFile(file);
      const res = await analyzeDecoded(decoded, isDemo);
      if (isDemo) demo = { report: res.report, spectrum: res.spectrum };
      else stems.push({ name: file.name, analysis: res.report, spectrum: res.spectrum });
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }
  setProgress(jobs.length, jobs.length, `完了（${((performance.now() - t0) / 1000).toFixed(1)} 秒）`);
  $('analyze-btn').disabled = false;

  if (errors.length) showError(`一部のファイルを読み込めませんでした:\n${errors.join('\n')}`);
  if (!stems.length) return;

  // classification, demo similarity, pairwise overlap
  for (const s of stems) {
    s.autoClassification = classify(s.name, s.analysis);
    s.classification = { ...s.autoClassification };
    if (demo) s.analysis.demo_similarity = spectralOverlap(s.spectrum, demo.spectrum);
  }
  const overlaps = {};
  for (let i = 0; i < stems.length; i++)
    for (let j = i + 1; j < stems.length; j++)
      overlaps[`${stems[i].name} <> ${stems[j].name}`] = spectralOverlap(stems[i].spectrum, stems[j].spectrum);

  Object.assign(state, { demo, stems, overlaps });
  renderResults();
  $('results').hidden = false;
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const fmtDb = (v, unit = '') => (v === null || v === undefined ? '—' : `${v.toFixed(1)}<small>${unit}</small>`);
const pct = (v) => `${Math.round(v * 100)}%`;

function balanceBar(b, cls = 'balance-bar') {
  return `<div class="${cls}" role="img" aria-label="Low ${pct(b.low)} / Mid ${pct(b.mid)} / High ${pct(b.high)}">
    <i class="low" style="width:${b.low * 100}%"></i><i class="mid" style="width:${b.mid * 100}%"></i><i class="high" style="width:${b.high * 100}%"></i></div>`;
}

function envelopeSvg(report) {
  const env = report.loudness_envelope_2s || [];
  if (env.length < 2) return '<p class="empty">曲が短いため推移グラフは省略しました。</p>';
  const W = 800, H = 170, P = { l: 40, r: 10, t: 10, b: 24 };
  const vals = env.map((e) => e.short_term_lufs);
  const lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1);
  const dur = report.duration_sec;
  const x = (t) => P.l + (t / dur) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
  const secColor = { high: 'var(--accent)', low: 'var(--foundation)', mid: 'transparent', silence: 'transparent' };
  const rects = (report.estimated_sections || []).map((s) =>
    `<rect x="${x(s.start_sec)}" y="${P.t}" width="${Math.max(0, x(Math.min(s.end_sec, dur)) - x(s.start_sec))}" height="${H - P.t - P.b}" fill="${secColor[s.energy]}" opacity=".12"/>`).join('');
  const pts = env.map((e) => `${x(e.time_sec + 1).toFixed(1)},${y(e.short_term_lufs).toFixed(1)}`).join(' ');
  const il = report.integrated_lufs;
  const ticks = [];
  const step = dur > 240 ? 60 : dur > 60 ? 30 : dur > 20 ? 10 : 2;
  for (let t = 0; t <= dur; t += step) {
    const m = Math.floor(t / 60), s = String(Math.round(t % 60)).padStart(2, '0');
    ticks.push(`<text x="${x(t)}" y="${H - 6}" text-anchor="middle">${m}:${s}</text>`);
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="2秒ごとのラウドネス推移">
    <g font-family="JetBrains Mono, monospace" font-size="11" fill="var(--ink-3)">
      ${rects}
      <text x="4" y="${y(hi) + 10}">${hi}</text><text x="4" y="${y(lo)}">${lo}</text>
      ${il !== null ? `<line x1="${P.l}" x2="${W - P.r}" y1="${y(il)}" y2="${y(il)}" stroke="var(--ink-3)" stroke-dasharray="4 4"/><text x="${W - P.r}" y="${y(il) - 4}" text-anchor="end">Integrated ${il}</text>` : ''}
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
      ${ticks.join('')}
    </g></svg>`;
}

function fmtTime(s) { return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`; }

function renderDemo() {
  const d = state.demo?.report;
  if (!d) {
    $('demo-body').innerHTML = '<p class="empty">demoが読み込まれていないため、役割ターゲットのみで推奨値を計算しています（demoを入れると空間系・帯域バランスの補正が加わります）。</p>';
    return;
  }
  const b = d.band_energy;
  const secs = (d.estimated_sections || []).filter((s) => s.energy !== 'silence')
    .map((s) => `<span class="sec-chip ${s.energy}">${fmtTime(s.start_sec)}–${fmtTime(Math.min(s.end_sec, d.duration_sec))} ${esc(s.hint)}</span>`).join('');
  $('demo-body').innerHTML = `
    <div class="stats">
      <div class="stat"><b>${fmtDb(d.integrated_lufs, 'LUFS')}</b><span>Integrated</span></div>
      <div class="stat"><b>${fmtDb(d.short_term_lufs_max, 'LUFS')}</b><span>Short-term 最大</span></div>
      <div class="stat"><b>${fmtDb(d.true_peak_dbtp, 'dBTP')}</b><span>True Peak</span></div>
      <div class="stat"><b>${fmtDb(d.rms_db, 'dB')}</b><span>RMS</span></div>
      <div class="stat"><b>${d.stereo_width.toFixed(2)}</b><span>ステレオ幅 (S/M)</span></div>
      <div class="stat"><b>${Math.round(d.spectral_centroid_hz)}<small>Hz</small></b><span>スペクトル重心</span></div>
    </div>
    <div class="balance">
      <p class="sub">帯域バランス</p>
      ${balanceBar(b)}
      <div class="balance-key">
        <span><i style="background:var(--low)"></i>Low 20–250Hz ${pct(b.low)}</span>
        <span><i style="background:var(--mid)"></i>Mid 250–4kHz ${pct(b.mid)}</span>
        <span><i style="background:var(--high)"></i>High 4k–20kHz ${pct(b.high)}</span>
      </div>
    </div>
    <p class="sub">ラウドネス推移とセクション推定（目安）</p>
    <div class="envelope">${envelopeSvg(d)}</div>
    ${secs ? `<div class="sections">${secs}</div>` : ''}`;
}

function confBadge(c) {
  if (c.overridden) return '<span class="conf manual">手動設定</span>';
  const label = { high: '分類: 確度高', medium: '分類: 確度中', low: '分類: 要確認' }[c.confidence];
  return `<span class="conf ${c.confidence}">${label}</span>`;
}

function trackCard(stem, t) {
  const c = stem.classification;
  const a = stem.analysis;
  const v = t.volume_db;
  const w = Math.min(Math.abs(v) / 6, 1) * 50;
  const fill = v >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
  const opts = ROLES.map((r) => `<option value="${r}" ${r === c.role ? 'selected' : ''}>${r}（${ROLE_LABEL_JA[r]}）</option>`).join('');
  const eq = t.eq.map((bnd) => {
    const s = formatEqBand(bnd);
    const [main, note] = s.split('   (');
    return `<li>${esc(main)}${note ? ` <span class="note">${esc(note.replace(/\)$/, ''))}</span>` : ''}</li>`;
  }).join('');
  const comp = t.compressor
    ? `${t.compressor.ratio} · Atk ${t.compressor.attack_ms}ms · Rel ${t.compressor.release_ms}ms<br>Thr ${t.compressor.threshold_db}dB · Makeup +${t.compressor.makeup_gain_db}dB`
    : '<span class="muted">不要（持続音のため）</span>';
  const how = { filename: 'ファイル名から', filename_generic: 'ファイル名（汎用）から', acoustic_features: '音響特徴から' }[stem.autoClassification.method];
  return `
  <article class="track role-${c.role}">
    <div class="track-head">
      <div>
        <p class="track-name">${esc(stem.name)}</p>
        <p class="track-meta">${esc(c.instrument)} · ${how}推定${c.secondary_role ? ` · 副: ${c.secondary_role}` : ''}</p>
      </div>
      ${confBadge(c)}
    </div>
    <label class="role-select"><select data-stem="${esc(stem.name)}" aria-label="${esc(stem.name)}の役割">${opts}</select></label>
    <div class="fader">
      <span class="fader-label">Volume</span>
      <div class="fader-track"><i style="${fill}"></i></div>
      <span class="fader-val">${v >= 0 ? '+' : ''}${v.toFixed(1)} dB</span>
    </div>
    <dl class="kv">
      <dt>Pan</dt><dd>${esc(t.pan)}</dd>
      <dt>EQ</dt><dd><ul>${eq}</ul></dd>
      <dt>Comp</dt><dd>${comp}</dd>
      <dt>Send</dt><dd>Reverb ${pct(t.reverb_send)} · Delay ${pct(t.delay_send)}</dd>
      <dt>計測</dt><dd>${a.integrated_lufs ?? '—'} LUFS · TP ${a.true_peak_dbtp ?? '—'} dBTP${a.demo_similarity !== undefined ? `<br>demo類似度 ${a.demo_similarity}` : ''}</dd>
      <dt>帯域</dt><dd>${balanceBar(a.band_energy, 'mini-balance')}</dd>
    </dl>
  </article>`;
}

function renderTracks(mix) {
  $('legend').innerHTML = ROLES.map((r) => `<span class="role-${r}">${r} = ${ROLE_LABEL_JA[r]}</span>`).join('');
  const byName = new Map(state.stems.map((s) => [s.name, s]));
  $('tracks').innerHTML = sortedTracks(mix).map(([name, t]) => trackCard(byName.get(name), t)).join('');
}

function renderMasking() {
  const pairs = Object.entries(state.overlaps).sort((a, b) => b[1] - a[1]);
  const top = pairs.filter(([, v]) => v >= 0.5).slice(0, 8);
  if (!pairs.length) { $('masking').innerHTML = '<p class="empty">stemが1本のため比較対象がありません。</p>'; return; }
  if (!top.length) { $('masking').innerHTML = '<p class="empty">類似度0.5以上の組み合わせはありません。帯域の住み分けは良好です。</p>'; return; }
  $('masking').innerHTML = `<ul class="mask-list">${top.map(([k, v]) =>
    `<li><span class="pair" title="${esc(k)}">${esc(k.replace(' <> ', ' × '))}</span><span class="bar"><i style="width:${v * 100}%"></i></span><span class="val">${v.toFixed(2)}</span></li>`).join('')}</ul>`;
}

function buildOutputs(mix) {
  const demo = state.demo?.report || null;
  const analysis = {
    engine: 'Weno AutoMix Engine v0.1 (web)',
    project: mix.project,
    demo,
    stems: state.stems.map((s) => ({ ...s.analysis, classification: s.classification })),
    spectral_overlap_pairs: state.overlaps,
  };
  const notes = logicNotes(mix);
  state.outputs = {
    'analysis_report.json': toJson(analysis),
    'mix_settings.json': toJson(mix),
    'logic_notes.txt': notes,
  };
  $('notes-preview').textContent = notes;
}

function renderResults() {
  const project = $('project-name').value.trim() || 'song_01';
  const mix = generateMixSettings(project, state.stems, state.demo?.report || null);
  renderDemo();
  renderTracks(mix);
  renderMasking();
  buildOutputs(mix);
}

// role overrides
$('tracks').addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-stem]');
  if (!sel) return;
  const stem = state.stems.find((s) => s.name === sel.dataset.stem);
  if (!stem) return;
  const auto = stem.autoClassification;
  stem.classification = sel.value === auto.role
    ? { ...auto }
    : { ...auto, role: sel.value, secondary_role: null, overridden: true };
  renderResults();
});

$('project-name').addEventListener('change', () => { if (state.stems.length) renderResults(); });

// downloads
document.querySelector('.downloads').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-file]');
  if (!btn || !state.outputs) return;
  const name = btn.dataset.file;
  const type = name.endsWith('.json') ? 'application/json' : 'text/plain';
  const url = URL.createObjectURL(new Blob([state.outputs[name]], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

bindDrop('demo-drop', 'demo-input', setDemo);
bindDrop('stems-drop', 'stems-input', addStems);
$('analyze-btn').addEventListener('click', runAnalysis);
$('clear-btn').addEventListener('click', () => {
  Object.assign(state, { demoFile: null, stemFiles: [], demo: null, stems: [], overlaps: {}, outputs: null });
  renderFileLists();
  $('results').hidden = true;
  $('progress').hidden = true;
  showError('');
});
$('sample-btn').addEventListener('click', () => {
  const { demo, stems } = makeSampleProject();
  state.demoFile = demo;
  state.stemFiles = stems;
  $('project-name').value = 'sample_song';
  renderFileLists();
  runAnalysis();
});
renderFileLists();
