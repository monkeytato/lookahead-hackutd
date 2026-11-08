// Builds docs/CenterGuard-Prediction-Science.pdf from the project's own data and engine code.
//
//   node docs/pdf-src/build.mjs            (from the repo root; Node >= 23 for .ts type stripping)
//
// Every chart value is read from research/derived/*.json, research/data/published-transients/*.csv,
// reports/validation-2026-11-08-*.md, or computed by running the shipped engine functions
// (src/domain/engine/thermalZone.ts simulateThermal, evidence.ts evidencePosterior) with the
// parameters of tests/engine/thermalZone.test.ts / tests/engine/evidence.test.ts. Nothing is typed in.
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const R = (p) => join(ROOT, p);
const OUT_HTML = join(HERE, 'CenterGuard-Prediction-Science.html');
const OUT_PDF = R('docs/CenterGuard-Prediction-Science.pdf');

// ------------------------------------------------------------------ palette (validated with dataviz validate_palette.js)
const C = {
  teal: '#00a090', // model / ensemble
  orange: '#c8692b', // published / measured data
  blue: '#2f5aa6', // third series
  gray: '#87948f', // legacy / reference
  ink: '#061a45',
  ink2: '#50615d',
  ink3: '#677771',
  grid: '#e3e6e1',
  axis: '#b9c0bb',
  band: '#eef4f1',
  surface: '#ffffff',
};

// ------------------------------------------------------------------ data
const kG1 = JSON.parse(readFileSync(R('research/derived/thermal_backtest_kG1.json'), 'utf8'));
const kG2 = JSON.parse(readFileSync(R('research/derived/thermal_backtest_kG2.json'), 'utf8'));
const dfw = JSON.parse(readFileSync(R('research/derived/dfw_weather_summary.json'), 'utf8'));
const rel = JSON.parse(readFileSync(R('research/derived/reliability_priors.json'), 'utf8'));

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const cells = l.match(/("[^"]*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
    return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  });
}
const transients = parseCsv(readFileSync(R('research/data/published-transients/cooling_outage_points.csv'), 'utf8'));
const tp = (source, kase, t, metric) => {
  const row = transients.find((r) => r.source_id === source && r.case === kase && r.t_s === String(t) && (!metric || r.metric === metric));
  if (!row) throw new Error(`missing transient ${source} ${kase} ${t}`);
  return Number(row.value);
};

/** "| all | 86067 | 24 % | 3.0 min | ..." → overall row + first-rack line from a validation report */
function readReport(file) {
  const md = readFileSync(R(`reports/${file}`), 'utf8');
  const all = md.split('\n').find((l) => l.startsWith('| all |'));
  const cells = all.split('|').map((c) => c.trim()).filter(Boolean);
  const first = md.match(/First rack right: \*\*(\d+) %\*\* of (\d+) judged/);
  const secs = md.match(/seed 1, (\d+) s\./);
  const byType = {};
  const sec = md.split('## By asset type')[1]?.split('##')[0] ?? '';
  for (const l of sec.split('\n')) {
    const c = l.split('|').map((x) => x.trim()).filter(Boolean);
    if (c.length >= 3 && /^\d+ %$/.test(c[2])) byType[c[0]] = Number(c[2].replace(' %', ''));
  }
  return {
    losses: Number(cells[1]), coverage: Number(cells[2].replace(' %', '')), p50err: cells[3], bias: cells[4], missed: cells[5], falseAlarms: cells[6],
    firstRack: first ? Number(first[1]) : null, judged: first ? Number(first[2]) : null, seconds: secs ? Number(secs[1]) : null, byType,
  };
}
const REP = {
  legacy: readReport('validation-2026-11-08-default.md'),
  prior: readReport('validation-2026-11-08-default-ensemble-prior_predictive.md'),
  perturbed: readReport('validation-2026-11-08-default-ensemble-perturbed.md'),
  ensVsLegacy: readReport('validation-2026-11-08-default-ensemble-legacy.md'),
};

// ------------------------------------------------------------------ the shipped engine (read-only imports)
const tz = await import('../../src/domain/engine/thermalZone.ts');
const ev = await import('../../src/domain/engine/evidence.ts');
const { simulateThermal, RHO_AIR, CP_AIR, IT_AIRFLOW_M3S_PER_KW } = tz;

// WP179 Example 1, exactly as tests/engine/thermalZone.test.ts (k_G = 2, eps = 0.8, instant chiller restart)
const KG = 2;
const wp179 = (waterM3, restartMin) => simulateThermal({
  airVolM3: 30 * 24 * 4.6, itMassJperK: 100 * 545 * 650, waterM3, crahFlowM3s: 45, G: KG * 0.8 * RHO_AIR * CP_AIR * 400 * IT_AIRFLOW_M3S_PER_KW,
  P: 400e3, TsetAir: 20, TsetWater: 7.2, epsCoil: 0.75, Qcap: 400e3 * 1.25,
  fansOn: (t) => t >= 60, chillerOn: (t) => t >= restartMin * 60, horizonS: 40 * 60, every: 5, dt: 1,
});
const peak = (s) => Math.max(...s.map((x) => x.Ta));
let fitW = 0.25, fitErr = Infinity;
for (let w = 0.25; w <= 10; w += 0.25) { const e = Math.abs(peak(wp179(w, 12)) - tp('WP179', 'example1_baseline', 'peak')); if (e < fitErr) { fitErr = e; fitW = w; } }
const WP = { 12: wp179(fitW, 12), 5: wp179(fitW, 5), 4: wp179(fitW, 4) };
const WPPEAK = Object.fromEntries(Object.entries(WP).map(([k, s]) => [k, Math.round(peak(s) * 10) / 10]));

// WP179 CFD room, as the test (load inferred from the 0–30 s slope; rack count assumed)
const cfdVol = 10 * 10.7 * (2.6 + 0.61);
const cfdP = ((tp('WP179', 'cfd_no_recovery', 30) - tp('WP179', 'cfd_no_recovery', 0)) / 30) * RHO_AIR * CP_AIR * cfdVol * 1.05;
const cfdRacks = Math.round(cfdP / 4000);
const cfd = (eps) => simulateThermal({ airVolM3: cfdVol, itMassJperK: cfdRacks * 545 * 650, waterM3: 1, crahFlowM3s: 1e-9, G: KG * eps * RHO_AIR * CP_AIR * (cfdP / 1000) * IT_AIRFLOW_M3S_PER_KW, P: cfdP, Ta0: tp('WP179', 'cfd_no_recovery', 0), TsetAir: 28.4, TsetWater: 7, epsCoil: 0, Qcap: 0, fansOn: () => false, chillerOn: () => false, horizonS: 300, every: 5 });
const CFD = { 0.7: cfd(0.7), 0.8: cfd(0.8), 0.9: cfd(0.9) };

// Evidence posterior with the shipped DEFAULT_ERROR_MODEL, installed 34.2 °C, baseline 23.5 °C (dossier worked example inputs)
const evCurve = (prior) => {
  const pts = [];
  for (let y = 20; y <= 36.0001; y += 0.1) pts.push([y, ev.evidencePosterior({ metric: 'inlet_temp_c', installed: { value: 34.2 }, reference: { mean: y, n: 10 }, modelBaseline: { mean: 23.5 }, priorReal: prior }).pReal]);
  return pts;
};
const EV = { 0.2: evCurve(0.2), 0.5: evCurve(0.5), 0.8: evCurve(0.8) };
const workedEM = { sigmaInstalled: { value: 1, basis: 'x' }, sigmaRef: { value: 0.3, basis: 'x' }, sigmaSpatial: { value: 1.5, basis: 'x' }, sigmaModel: { value: 1.5, basis: 'x' } };
const worked = (y) => ev.evidencePosterior({ metric: 'inlet_temp_c', installed: { value: 34.2 }, reference: { mean: y, n: 10 }, modelBaseline: { mean: 23.5 }, errorModel: workedEM });
const EVW = { 24: worked(24), 31: worked(31) };
const EM = ev.DEFAULT_ERROR_MODEL;
const leakWet = ev.evidencePosterior({ metric: 'leak', installed: { value: 1 }, reference: { mean: 1, n: 10 }, modelBaseline: { mean: 0 } }).pReal;

// ------------------------------------------------------------------ SVG helpers
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const lin = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
const logS = (d0, d1, r0, r1) => (v) => r0 + ((Math.log10(v) - Math.log10(d0)) / (Math.log10(d1) - Math.log10(d0))) * (r1 - r0);
const T = (x, y, s, o = {}) => `<text x="${f1(x)}" y="${f1(y)}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''} font-size="${o.size ?? 11}"${o.weight ? ` font-weight="${o.weight}"` : ''} fill="${o.fill ?? C.ink2}"${o.rotate ? ` transform="rotate(${o.rotate} ${f1(x)} ${f1(y)})"` : ''}${o.family ? ` font-family="${o.family}"` : ''}>${esc(s)}</text>`;
const L = (x1, y1, x2, y2, o = {}) => `<line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="${o.stroke ?? C.axis}" stroke-width="${o.w ?? 1}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}${o.cap ? ` stroke-linecap="${o.cap}"` : ''}/>`;
const path = (pts, o = {}) => `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${f1(p[0])},${f1(p[1])}`).join('')}" fill="none" stroke="${o.stroke}" stroke-width="${o.w ?? 2}" stroke-linejoin="round" stroke-linecap="round"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`;
const dot = (x, y, o = {}) => `<circle cx="${f1(x)}" cy="${f1(y)}" r="${o.r ?? 4.5}" fill="${o.fill}" stroke="${o.ring ?? C.surface}" stroke-width="2"/>`;
const diamond = (x, y, o = {}) => { const r = o.r ?? 5.5; return `<path d="M${f1(x)},${f1(y - r)}L${f1(x + r)},${f1(y)}L${f1(x)},${f1(y + r)}L${f1(x - r)},${f1(y)}Z" fill="${o.fill}" stroke="${C.surface}" stroke-width="2"/>`; };
const rect = (x, y, w, h, o = {}) => `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(Math.max(0, w))}" height="${f1(Math.max(0, h))}" fill="${o.fill}"${o.rx ? ` rx="${o.rx}"` : ''}${o.opacity ? ` fill-opacity="${o.opacity}"` : ''}/>`;
/** Bar with 4px rounded data end, square at the baseline (horizontal bar: baseline at x0). */
const hbar = (x0, x1, y, h, fill) => {
  const r = Math.min(4, (x1 - x0) / 2, h / 2);
  return `<path d="M${f1(x0)},${f1(y)}H${f1(x1 - r)}Q${f1(x1)},${f1(y)} ${f1(x1)},${f1(y + r)}V${f1(y + h - r)}Q${f1(x1)},${f1(y + h)} ${f1(x1 - r)},${f1(y + h)}H${f1(x0)}Z" fill="${fill}"/>`;
};
const vbar = (x, y0, y1, w, fill) => {
  if (y0 - y1 < 0.5) return '';
  const r = Math.min(4, w / 2, (y0 - y1) / 2);
  return `<path d="M${f1(x)},${f1(y0)}V${f1(y1 + r)}Q${f1(x)},${f1(y1)} ${f1(x + r)},${f1(y1)}H${f1(x + w - r)}Q${f1(x + w)},${f1(y1)} ${f1(x + w)},${f1(y1 + r)}V${f1(y0)}Z" fill="${fill}"/>`;
};
const svg = (w, h, body, label) => `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Sans, Segoe UI, sans-serif">${body}</svg>`;

/** Axes with recessive grid. Returns {sx, sy, g} */
function axes({ w, h, m, x, y }) {
  const sx = (x.log ? logS : lin)(x.min, x.max, m.l, w - m.r);
  const sy = (y.log ? logS : lin)(y.min, y.max, h - m.b, m.t);
  let g = '';
  for (const v of y.ticks) { g += L(m.l, sy(v), w - m.r, sy(v), { stroke: C.grid }); g += T(m.l - 6, sy(v) + 4, y.fmt ? y.fmt(v) : v, { anchor: 'end', size: 10, fill: C.ink3 }); }
  for (const v of x.ticks) { g += T(sx(v), h - m.b + 15, x.fmt ? x.fmt(v) : v, { anchor: 'middle', size: 10, fill: C.ink3 }); }
  g += L(m.l, h - m.b, w - m.r, h - m.b, { stroke: C.axis });
  if (x.label) g += T((m.l + w - m.r) / 2, h - 6, x.label, { anchor: 'middle', size: 10.5, fill: C.ink2 });
  if (y.label) g += T(14, (m.t + h - m.b) / 2, y.label, { anchor: 'middle', size: 10.5, fill: C.ink2, rotate: -90 });
  return { sx, sy, g };
}
/** Legend row, top-left of the plot. items: [{label, color, kind: 'line'|'dot'|'dash'|'bar'|'diamond'}] */
function legend(x, y, items) {
  let g = '', cx = x;
  for (const it of items) {
    if (it.kind === 'dot') g += dot(cx + 6, y - 4, { fill: it.color, r: 4 });
    else if (it.kind === 'diamond') g += diamond(cx + 6, y - 4, { fill: it.color, r: 5 });
    else if (it.kind === 'ring') g += `<circle cx="${f1(cx + 6)}" cy="${f1(y - 4)}" r="3.5" fill="none" stroke="${it.color}" stroke-width="1.5"/>`;
    else if (it.kind === 'bar') g += rect(cx, y - 9, 12, 10, { fill: it.color, rx: 2 });
    else g += L(cx, y - 4, cx + 16, y - 4, { stroke: it.color, w: 2, dash: it.kind === 'dash' ? '4 3' : undefined, cap: 'round' });
    g += T(cx + 21, y, it.label, { size: 10.5, fill: C.ink2 });
    cx += 21 + it.label.length * 5.9 + 16;
  }
  return g;
}

// ------------------------------------------------------------------ charts
const CH = {};

// Fig: WP179 Example 1 backtest (model curves from the shipped simulateThermal; published values from the CSV)
{
  const w = 680, h = 248, m = { l: 46, r: 150, t: 30, b: 40 };
  const { sx, sy, g } = axes({ w, h, m, x: { min: 0, max: 40, ticks: [0, 5, 10, 15, 20, 25, 30, 35, 40], label: 'Minutes after utility loss' }, y: { min: 18, max: 44, ticks: [20, 24, 28, 32, 36, 40, 44], fmt: (v) => `${v}`, label: 'Room air, °C' } });
  let b = g;
  const pubs = [
    { v: tp('WP179', 'example1_baseline', 'peak'), a: 'peak', c: 'restart at 12 min' },
    { v: tp('WP179', 'example1_restart5', 'peak'), a: 'peak', c: 'restart at 5 min' },
    { v: tp('WP179', 'example1_restart4', 'peak'), a: 'bound', c: 'restart at 4 min' },
  ];
  for (const p of pubs) {
    b += L(m.l, sy(p.v), w - m.r, sy(p.v), { stroke: C.orange, w: 1.25, dash: '5 4' });
    b += T(w - m.r + 8, sy(p.v) + 1, `${f1(p.v)} °C published ${p.a}`, { size: 10, fill: C.ink2 });
    b += T(w - m.r + 8, sy(p.v) + 13, p.c, { size: 9.5, fill: C.ink3 });
  }
  const series = [{ k: 12, c: C.teal }, { k: 5, c: C.blue }, { k: 4, c: C.gray }];
  for (const s of series) b += path(WP[s.k].map((x) => [sx(x.t / 60), sy(x.Ta)]), { stroke: s.c, w: 2 });
  { const pk = WP[12].reduce((a, x) => (x.Ta > a.Ta ? x : a)); b += T(sx(pk.t / 60) + 6, sy(pk.Ta) - 6, `model peak ${f1(pk.Ta)}`, { size: 10, fill: C.ink, weight: 500 }); }
  b += T(sx(19), sy(25.6), `Model peaks: ${f1(WPPEAK[12])} (12 min) · ${f1(WPPEAK[5])} (5 min) · ${f1(WPPEAK[4])} °C (4 min)`, { size: 10, fill: C.ink });
  const backT = tp('WP179', 'example1_baseline', 1020) / 60;
  b += dot(sx(backT), sy(32), { fill: C.orange, r: 4.5 });
  b += L(sx(backT), sy(32) + 5, sx(backT), sy(23.4), { stroke: C.orange, w: 1 }) + T(sx(backT) + 6, sy(23), `published: above 32 °C until about ${Math.round(backT)} min`, { size: 9.5, fill: C.ink2 });
  b += legend(m.l, 16, [{ label: 'Restart 12 min (model)', color: C.teal }, { label: 'Restart 5 min (model)', color: C.blue }, { label: 'Restart 4 min (model)', color: C.gray }, { label: 'WP179 published (S)', color: C.orange, kind: 'dash' }]);
  CH.wp179 = svg(w, h, b, 'WP179 Example 1: model room-air curves for chiller restarts at 12, 5 and 4 minutes against the published peaks');
}

// Fig: WP179 CFD room, no recovery
{
  const w = 400, h = 232, m = { l: 44, r: 16, t: 30, b: 40 };
  const { sx, sy, g } = axes({ w, h, m, x: { min: 0, max: 300, ticks: [0, 60, 120, 180, 240, 300], label: 'Seconds after cooling loss' }, y: { min: 26, max: 42, ticks: [26, 30, 34, 38, 42], label: 'Room air, °C' } });
  let b = g;
  const lo = CFD[0.9], hi = CFD[0.7];
  const band = [...hi.map((x) => [sx(x.t), sy(x.Ta)]), ...lo.slice().reverse().map((x) => [sx(x.t), sy(x.Ta)])];
  b += `<path d="${band.map((p, i) => `${i ? 'L' : 'M'}${f1(p[0])},${f1(p[1])}`).join('')}Z" fill="${C.teal}" fill-opacity="0.14"/>`;
  b += path(CFD[0.8].map((x) => [sx(x.t), sy(x.Ta)]), { stroke: C.teal, w: 2 });
  for (const t of [0, 30, 60, 300]) b += dot(sx(t), sy(tp('WP179', 'cfd_no_recovery', t)), { fill: C.orange, r: 4.5 });
  const end = CFD[0.8].at(-1);
  b += T(sx(300) - 4, sy(end.Ta) - 9, `model ${f1(end.Ta)}`, { anchor: 'end', size: 10, fill: C.ink, weight: 500 });
  b += T(sx(300) - 4, sy(tp('WP179', 'cfd_no_recovery', 300)) + 18, `published ${f1(tp('WP179', 'cfd_no_recovery', 300))}`, { anchor: 'end', size: 10, fill: C.ink2 });
  b += legend(m.l, 16, [{ label: 'Model, ε 0.8 (band 0.7–0.9)', color: C.teal }, { label: 'WP179 CFD (S)', color: C.orange, kind: 'dot' }]);
  CH.cfd = svg(w, h, b, 'WP179 CFD room: model curve and band against four published points');
}

// Fig: the two clocks in the fixture hall (research-script Monte Carlo, k_G = 2)
{
  const w = 680, h = 268, m = { l: 210, r: 60, t: 34, b: 40 };
  const groups = [
    { title: 'CRAH-pair fans off (north zone, 190 kW)', d: kG2.fixture_crah_pair_fans_off },
    { title: 'Both chillers lost, fans running (351 kW to air)', d: kG2.fixture_chillers_lost_fans_on },
  ];
  const { sx, g } = axes({ w, h, m, x: { min: 0, max: 45, ticks: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45], label: 'Minutes after the loss (bar p10–p90, tick p50); 2,000 trials, coupling factor 2' }, y: { min: 0, max: 1, ticks: [] } });
  let b = g, y = m.t - 10;
  const rowH = 17;
  const col = (k) => (k === 'to32' ? C.teal : k === 'to40' || k === 'to45' ? C.blue : C.gray);
  for (const grp of groups) {
    b += T(12, y + 10, grp.title, { size: 10.5, weight: 600, fill: C.ink });
    y += 16;
    for (const k of ['to27', 'to32', 'to35', 'to40', 'to45']) {
      const q = grp.d[k];
      const lab = `${k.slice(2)} °C${k === 'to32' ? ' · envelope (A1 allowable)' : k === 'to40' || k === 'to45' ? ' · service-impact range' : ''}`;
      b += T(m.l - 8, y + 11, lab, { anchor: 'end', size: 10, fill: C.ink2 });
      b += L(sx(q.p10), y + 7, sx(q.p90), y + 7, { stroke: col(k), w: 8, cap: 'round' });
      b += L(sx(q.p50), y + 1, sx(q.p50), y + 13, { stroke: C.ink, w: 2 });
      b += T(sx(q.p90) + 8, y + 11, `${q.p10}–${q.p90}`, { size: 9.5, fill: C.ink3, family: 'IBM Plex Mono, Consolas, monospace' });
      y += rowH;
    }
    y += 10;
  }
  CH.clocks = svg(w, h, b, 'Fixture hall Monte Carlo: minutes to 27, 32, 35, 40 and 45 °C after fan loss and after chiller loss');
}

// Fig: evidence posterior vs portable reading (shipped evidencePosterior, DEFAULT_ERROR_MODEL)
{
  const w = 680, h = 215, m = { l: 50, r: 20, t: 30, b: 40 };
  const { sx, sy, g } = axes({ w, h, m, x: { min: 20, max: 36, ticks: [20, 22, 24, 26, 28, 30, 32, 34, 36], label: 'Portable reference reading, °C (installed sensor reads 34.2 °C; baseline 23.5 °C)' }, y: { min: 0, max: 1, ticks: [0, 0.1, 0.5, 0.9, 1], fmt: (v) => v.toFixed(1), label: 'P(real)' } });
  let b = rect(m.l, sy(1), w - m.l - m.r, sy(0.9) - sy(1), { fill: C.band }) + rect(m.l, sy(0.1), w - m.l - m.r, sy(0) - sy(0.1), { fill: '#f4f1ec' }) + g;
  b += T(m.l + 6, sy(0.9) + 13, 'corroborated_abnormal (P ≥ 0.9)', { size: 9.5, fill: C.ink3 });
  b += T(w - m.r - 6, sy(0.1) - 5, 'measurement_disagreement (P ≤ 0.1)', { anchor: 'end', size: 9.5, fill: C.ink3 });
  for (const [v, lab] of [[23.5, 'baseline 23.5'], [34.2, 'installed 34.2']]) { b += L(sx(v), m.t, sx(v), h - m.b, { stroke: C.axis, dash: '3 3' }); b += T(sx(v) + 4, sy(0.5) + 4, lab, { size: 9.5, fill: C.ink3 }); }
  b += path(EV[0.2].map(([x, p]) => [sx(x), sy(p)]), { stroke: C.gray, w: 2, dash: '5 4' });
  b += path(EV[0.8].map(([x, p]) => [sx(x), sy(p)]), { stroke: C.blue, w: 2 });
  b += path(EV[0.5].map(([x, p]) => [sx(x), sy(p)]), { stroke: C.teal, w: 2.5 });
  b += legend(m.l, 16, [{ label: 'Prior π = 0.5 (default)', color: C.teal }, { label: 'π = 0.8', color: C.blue }, { label: 'π = 0.2', color: C.gray, kind: 'dash' }]);
  CH.evidence = svg(w, h, b, 'Evidence posterior P(real) as a function of the portable reading for three priors');
}

// Fig: reliability priors on a log scale (reliability_priors.json; engine p from priors.ts)
{
  const od = rel.on_demand;
  const rows = [
    { lab: 'Generator fails to start', d: od.generator_fail_to_start, alt: od.generator_fail_to_start.alt },
    { lab: 'ATS fails to transfer', d: od.ats_fail_to_transfer },
    { lab: 'UPS drops load (vendor, WP75)', d: od.ups_drops_load_on_transfer_to_battery, vendor: true },
    { lab: 'Chiller fails to restart', d: od.chiller_fail_to_restart, used: od.chiller_fail_to_restart.mean + od.chiller_fail_to_restart.plus_unavailable_test_maint },
    { lab: 'Standby CRAH fails to start', d: od.standby_crah_fail_to_start, used: od.standby_crah_fail_to_start.mean + od.standby_crah_fail_to_start.plus_unavailable_test_maint },
    { lab: 'Breaker fails to open/close', d: od.breaker_fail_to_open_close },
    { lab: 'Pump fails to start', d: od.pump_fail_to_start },
  ];
  const w = 680, h = 56 + rows.length * 25, m = { l: 190, r: 24, t: 30, b: 40 };
  const ticks = [1e-5, 1e-4, 1e-3, 1e-2, 1e-1];
  const sup = ['−5', '−4', '−3', '−2', '−1'];
  const { sx, g } = axes({ w, h, m, x: { min: 5e-6, max: 1e-1, log: true, ticks, fmt: (v) => `1e${sup[ticks.indexOf(v)]}`, label: 'Probability per demand (log scale)' }, y: { min: 0, max: 1, ticks: [] } });
  let b = g;
  for (const v of ticks) b += L(sx(v), m.t, sx(v), h - m.b, { stroke: C.grid });
  rows.forEach((r, i) => {
    const y = m.t + 12 + i * 25;
    b += T(m.l - 10, y + 4, r.lab, { anchor: 'end', size: 10.5, fill: C.ink });
    if (r.d.p05 !== undefined) b += L(sx(r.d.p05), y, sx(r.d.p95), y, { stroke: C.teal, w: 2.5, cap: 'round' });
    if (r.alt) for (const v of Object.values(r.alt)) b += `<circle cx="${f1(sx(v))}" cy="${f1(y)}" r="3.5" fill="none" stroke="${C.gray}" stroke-width="1.5"/>`;
    b += dot(sx(r.d.mean), y, { fill: r.vendor ? C.gray : C.teal, r: 4.5 });
    if (r.used) b += diamond(sx(r.used), y, { fill: C.orange, r: 5.5 });
  });
  b += legend(m.l - 150, 16, [{ label: 'INL mean', color: C.teal, kind: 'dot' }, { label: 'INL p05–p95', color: C.teal }, { label: 'engine p incl. maintenance', color: C.orange, kind: 'diamond' }, { label: 'other fleets (generator)', color: C.gray, kind: 'ring' }]);
  CH.reliability = svg(w, h, b, 'Per-demand failure probabilities from INL/EXT-21-65055 on a log scale');
}

// Fig: DFW hot hours per year (Open-Meteo, dfw_weather_summary.json)
{
  const yrs = dfw.openMeteo.years;
  const w = 680, h = 215, m = { l: 50, r: 16, t: 30, b: 40 };
  const { sy, g } = axes({ w, h, m, x: { min: 0, max: 1, ticks: [] }, y: { min: 0, max: 700, ticks: [0, 100, 200, 300, 400, 500, 600, 700], label: 'Hours per year' } });
  let b = g;
  const slot = (w - m.l - m.r) / yrs.length, bw = 16;
  yrs.forEach((yr, i) => {
    const x0 = m.l + i * slot + slot / 2 - bw - 1;
    b += vbar(x0, sy(0), sy(yr.hoursGe35), bw, C.teal);
    b += vbar(x0 + bw + 2, sy(0), sy(yr.hoursGe40), bw, C.orange);
    b += T(m.l + i * slot + slot / 2, h - m.b + 15, yr.year, { anchor: 'middle', size: 10, fill: C.ink3 });
    if (yr.year === 2023 || yr.year === 2022) { b += T(x0 + bw / 2, sy(yr.hoursGe35) - 5, yr.hoursGe35, { anchor: 'middle', size: 9.5, fill: C.ink }); b += T(x0 + bw * 1.5 + 2, sy(yr.hoursGe40) - 5, yr.hoursGe40, { anchor: 'middle', size: 9.5, fill: C.ink }); }
  });
  b += legend(m.l, 16, [{ label: 'Hours at or above 35 °C (chiller rating point)', color: C.teal, kind: 'bar' }, { label: 'Hours at or above 40 °C', color: C.orange, kind: 'bar' }]);
  CH.dfw = svg(w, h, b, 'Dallas–Fort Worth hours at or above 35 and 40 °C per year, 2016–2025');
}

// Fig: interval coverage (validation reports)
{
  const rows = [
    { lab: 'Before: legacy cascade vs its perturbed copy', v: REP.legacy.coverage, c: C.gray },
    { lab: 'Ensemble vs its own priors (self-consistency)', v: REP.prior.coverage, c: C.teal },
    { lab: 'Ensemble vs widened priors (perturbed reality)', v: REP.perturbed.coverage, c: C.teal },
    { lab: 'Ensemble vs perturbed legacy cascade', v: REP.ensVsLegacy.coverage, c: C.teal },
  ];
  const w = 680, h = 66 + rows.length * 28, m = { l: 260, r: 40, t: 30, b: 40 };
  const { sx, g } = axes({ w, h, m, x: { min: 0, max: 100, ticks: [0, 20, 40, 60, 80, 100], fmt: (v) => `${v} %`, label: 'Share of realised losses inside the predicted p10–p90' }, y: { min: 0, max: 1, ticks: [] } });
  let b = rect(sx(75), m.t, sx(85) - sx(75), h - m.b - m.t, { fill: C.band }) + g;
  b += L(sx(80), m.t, sx(80), h - m.b, { stroke: C.teal, dash: '3 3' });
  b += T(sx(80), m.t - 6, 'target 80 % (75–85 % band)', { anchor: 'middle', size: 9.5, fill: C.ink3 });
  rows.forEach((r, i) => {
    const y = m.t + 8 + i * 28;
    b += T(m.l - 10, y + 13, r.lab, { anchor: 'end', size: 10.5, fill: C.ink });
    b += hbar(sx(0), sx(r.v), y, 18, r.c);
    b += T(sx(r.v) + 6, y + 13, `${r.v} %`, { size: 10.5, weight: 600, fill: C.ink });
  });
  CH.coverage = svg(w, h, b, 'p10–p90 interval coverage before and after the overhaul');
}

// Fig: coverage by asset type (dot plot)
{
  const types = ['rack', 'crah', 'pdu', 'pump', 'chiller', 'battery', 'cdu', 'ups', 'ats'];
  const w = 680, h = 66 + types.length * 22, m = { l: 90, r: 24, t: 34, b: 40 };
  const { sx, g } = axes({ w, h, m, x: { min: 0, max: 100, ticks: [0, 20, 40, 60, 80, 100], fmt: (v) => `${v} %`, label: 'p10–p90 coverage by asset type' }, y: { min: 0, max: 1, ticks: [] } });
  let b = rect(sx(75), m.t, sx(85) - sx(75), h - m.b - m.t, { fill: C.band }) + g;
  types.forEach((t, i) => {
    const y = m.t + 12 + i * 22;
    b += T(m.l - 10, y + 4, t.toUpperCase(), { anchor: 'end', size: 10, fill: C.ink2 });
    b += L(sx(0), y, sx(100), y, { stroke: C.grid });
    const vals = [[REP.legacy.byType[t], C.gray], [REP.perturbed.byType[t], C.teal], [REP.prior.byType[t], C.blue]];
    for (const [v, c] of vals) if (v !== undefined) b += dot(sx(v), y, { fill: c, r: 5 });
  });
  b += legend(m.l, 16, [{ label: 'Legacy cascade (before)', color: C.gray, kind: 'dot' }, { label: 'Ensemble, perturbed reality', color: C.teal, kind: 'dot' }, { label: 'Ensemble, self-consistency', color: C.blue, kind: 'dot' }]);
  CH.coverageType = svg(w, h, b, 'Coverage by asset type for three validation regimes');
}

// Fig: system flow diagram
{
  const w = 680, h = 640;
  const box = (x, y, bw, bh, o = {}) => `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="5" fill="${o.fill ?? C.surface}" stroke="${o.stroke ?? '#c9d1cc'}" stroke-width="${o.sw ?? 1.25}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`;
  const arrow = (x1, y1, x2, y2, o = {}) => `<path d="M${x1},${y1}L${x2},${y2}" stroke="${o.c ?? C.ink2}" stroke-width="1.5" fill="none" marker-end="url(#ah${o.m ?? ''})"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`;
  const step = (n, x, y, title, sub, file) => T(x + 14, y + 22, n, { size: 12, weight: 600, fill: C.teal, family: 'IBM Plex Mono, Consolas, monospace' }) + T(x + 36, y + 22, title, { size: 12.5, weight: 600, fill: C.ink }) + T(x + 36, y + 40, sub, { size: 10.5, fill: C.ink2 }) + (file ? T(x + 446, y + 22, file, { anchor: 'end', size: 9.5, fill: C.ink3, family: 'IBM Plex Mono, Consolas, monospace' }) : '');
  let b = `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="${C.ink2}"/></marker><marker id="aht" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="${C.teal}"/></marker><marker id="aho" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="${C.orange}"/></marker></defs>`;
  const X = 24, W = 456, cx = X + W / 2;
  // inputs
  b += box(X, 8, 218, 52, { fill: '#f7f6f2' }) + T(X + 14, 29, 'Portable scan rig', { size: 12, weight: 600, fill: C.ink }) + T(X + 14, 46, 'DS18B20 probe and floor water probe', { size: 10, fill: C.ink2 });
  b += box(X + 238, 8, 218, 52, { fill: '#f7f6f2' }) + T(X + 252, 29, 'Installed sensors', { size: 12, weight: 600, fill: C.ink }) + T(X + 252, 46, 'BMS / IPMI readings and alarms', { size: 10, fill: C.ink2 });
  b += arrow(X + 109, 60, X + 160, 86) + arrow(X + 347, 60, X + 296, 86);
  const rows = [
    { y: 88, h: 54, n: '1', t: 'Evidence posterior P(real)', s: 'Student-t likelihood ratio over a stated error budget', f: 'evidence.ts' },
    { y: 166, h: 54, n: '2', t: 'No-foreknowledge forecast', s: 'Only faults observed or inferable by now; the rest become priors', f: 'observable.ts' },
    { y: 244, h: 122, n: '3', t: 'Two-level Monte Carlo ensemble', s: '256 parameter draws × 8 aleatory draws per response option', f: 'ensemble.ts' },
    { y: 390, h: 54, n: '4', t: 'Red-team stress regions, re-weighted', s: 'Defensive mixture α = 0.3; every trial weighted p/q', f: 'stress.ts' },
    { y: 468, h: 54, n: '5', t: 'EVSI next-scan ranking', s: 'Which reading could change the best action (rack-equivalents)', f: 'evsi.ts' },
    { y: 546, h: 54, n: '6', t: 'Operator UI: "Evaluate a response"', s: 'Racks impacted (model range), P(service down), first impact, next scan', f: 'EnsembleCompare.tsx' },
  ];
  rows.forEach((r, i) => {
    b += box(X, r.y, W, r.h, i === 2 ? { stroke: C.teal, sw: 1.5 } : {});
    b += step(r.n, X, r.y, r.t, r.s, r.f);
    if (i < rows.length - 1) b += arrow(cx, r.y + r.h, cx, rows[i + 1].y - 2);
  });
  // ensemble sub-blocks
  const subs = [['Physics|thermal zones', 'thermalZone.ts'], ['Reliability|priors (INL)', 'priors.ts'], ['Water|layer', 'water.ts'], ['Dependency|cascade', 'cascade.ts']];
  subs.forEach(([t, f], i) => {
    const sx0 = X + 14 + i * 108, sy0 = 244 + 56;
    const [l1, l2] = t.split('|'); b += box(sx0, sy0, 100, 52, { fill: C.band, stroke: '#cfe3dc' }) + T(sx0 + 50, sy0 + 19, l1, { anchor: 'middle', size: 10, weight: 600, fill: C.ink }) + T(sx0 + 50, sy0 + 31, l2, { anchor: 'middle', size: 10, weight: 600, fill: C.ink }) + T(sx0 + 50, sy0 + 46, f, { anchor: 'middle', size: 8.5, fill: C.ink3, family: 'IBM Plex Mono, Consolas, monospace' });
  });
  // Nemotron side box
  const NX = 512, NW = 156;
  b += box(NX, 370, NW, 94, { dash: '4 3', stroke: C.orange, fill: '#fdf6f1' });
  b += T(NX + 12, 390, 'Nemotron (or the', { size: 11, weight: 600, fill: C.ink }) + T(NX + 12, 404, 'cross-entropy fallback)', { size: 11, weight: 600, fill: C.ink });
  b += T(NX + 12, 422, 'proposes regions in a', { size: 10, fill: C.ink2 }) + T(NX + 12, 435, 'closed JSON grammar;', { size: 10, fill: C.ink2 }) + T(NX + 12, 448, 'never outputs a number', { size: 10, fill: C.ink2 });
  b += arrow(NX, 417, X + W + 2, 417, { c: C.orange, m: 'o' });
  b += T(NX + NW / 2 + 6, 489, 'grammar check', { size: 9.5, fill: C.ink3, family: 'IBM Plex Mono, Consolas, monospace' });
  b += box(NX, 506, NW, 70, { stroke: '#c9d1cc', fill: '#f7f6f2' });
  b += T(NX + 12, 526, 'Text validator', { size: 11, weight: 600, fill: C.ink }) + T(NX + 12, 542, 'strips any %, minute,', { size: 10, fill: C.ink2 }) + T(NX + 12, 555, 'count or "1 in N" not in', { size: 10, fill: C.ink2 }) + T(NX + 12, 568, 'a cited engine run', { size: 10, fill: C.ink2 });
  b += arrow(NX + NW / 2, 464, NX + NW / 2, 504, { c: C.ink3, dash: '3 3' });
  b += arrow(NX, 573, X + W + 2, 573);
  b += T(NX + 2, 596, 'validate.ts', { size: 9.5, fill: C.ink3, family: 'IBM Plex Mono, Consolas, monospace' });
  // P(real) feeds the ensemble directly as a hypothesis weight
  b += `<path d="M${X + W},115 C${X + W + 30},115 ${X + W + 30},300 ${X + W + 2},300" stroke="${C.teal}" stroke-width="1.5" fill="none" marker-end="url(#aht)"/>`;
  b += T(X + W + 34, 196, 'P(real) enters as the', { size: 9.5, fill: C.ink3 }) + T(X + W + 34, 208, 'probability of the', { size: 9.5, fill: C.ink3 }) + T(X + W + 34, 220, '"alarm is real" hypothesis', { size: 9.5, fill: C.ink3 });
  // feedback: next scan → portable rig
  b += `<path d="M${X},495 L${X - 14},495 L${X - 14},34 L${X - 2},34" stroke="${C.teal}" stroke-width="1.5" fill="none" stroke-dasharray="5 3" marker-end="url(#aht)"/>`;
  b += T(X - 18, 330, 'next scan → new evidence', { anchor: 'middle', size: 9.5, fill: C.teal, rotate: -90 });
  b += T(X, 628, 'Every number shown in step 6 is engine output from steps 1–5, cited by run id.', { size: 10, fill: C.ink3 });
  CH.flow = svg(w, h, b, 'System overview: sensors and portable scan to evidence posterior, forecast, ensemble, stress regions, EVSI and the operator UI');
}

// ------------------------------------------------------------------ backtest table, generated from the derived JSON
{
  const [a0, a4] = kG1.wp179, [b0, b4] = kG2.wp179;
  const c1 = kG1.wp179Cfd.model.find((m) => m.itEffectiveness === 0.8), c2 = kG2.wp179Cfd.model.find((m) => m.itEffectiveness === 0.8);
  const pub = kG2.wp179Cfd.published;
  const rows = [
    { t: 'Ex. 1 baseline peak, restart at 12 min (fitted)', p: b0.publishedBaselinePeakC, u: '°C', k1: [a0.baselinePeakC, a4.baselinePeakC], k2: [b0.baselinePeakC, b4.baselinePeakC], tol: 2.5, fitted: true },
    { t: 'Ex. 1 peak, restart at 5 min', p: b0.published5minRestartPeakC, u: '°C', k1: [a0.predicted5minRestartPeakC, a4.predicted5minRestartPeakC], k2: [b0.predicted5minRestartPeakC, b4.predicted5minRestartPeakC], tol: 2.5 },
    { t: 'Ex. 1 peak, restart at 4 min (published as a bound)', p: b0.published4minRestartPeakC, u: '°C', k1: [a0.predicted4minRestartPeakC, a4.predicted4minRestartPeakC], k2: [b0.predicted4minRestartPeakC, b4.predicted4minRestartPeakC], tol: 2.5 },
    { t: 'Ex. 1 last minute above 32 °C', p: b0.publishedUnacceptableUntilMin, u: 'min', k1: [a0.lastMinuteAbove32_12minRestart, a4.lastMinuteAbove32_12minRestart], k2: [b0.lastMinuteAbove32_12minRestart, b4.lastMinuteAbove32_12minRestart], tol: 5 },
    { t: 'CFD room at 60 s', p: pub['60'], u: '°C', k1: [c1.t60], k2: [c2.t60], tol: 1.5 },
    { t: 'CFD room at 300 s', p: pub['300'], u: '°C', k1: [c1.t300], k2: [c2.t300], tol: 3 },
  ];
  const fmt = (xs) => xs.map((x) => x.toFixed(1)).join(' / ');
  const status = (r) => {
    if (r.fitted) return 'fitted';
    const d = r.k2.map((x) => x - r.p);
    const ok = d.map((x) => Math.abs(x) <= r.tol + 1e-9);
    const s = d.map((x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`).join(' / ');
    return `${ok.every(Boolean) ? 'within' : ok.some(Boolean) ? 'partly within' : 'outside'} (${s})`;
  };
  CH.backtestTable = `<table><thead><tr><th>Published target (WP179, S)</th><th class="n">Published</th><th class="n">k<sub>G</sub> = 1</th><th class="n">k<sub>G</sub> = 2</th><th class="n">Acceptance</th><th>k<sub>G</sub> = 2 vs acceptance</th></tr></thead><tbody>${rows.map((r) => `<tr${r.fitted ? '' : ''}><td>${esc(r.t)}</td><td class="n">${r.p.toFixed(1)} ${r.u}</td><td class="n mono">${fmt(r.k1)}</td><td class="n mono">${fmt(r.k2)}</td><td class="n">± ${r.tol} ${r.u}</td><td>${status(r)}</td></tr>`).join('')}</tbody></table>`;
  CH.fit = `${b0.fittedLoopWaterM3} m³ (${b0.fittedLoopLitresPerKw} L/kW) at k<sub>G</sub> = 2, against ${a0.fittedLoopWaterM3} m³ (${a0.fittedLoopLitresPerKw} L/kW) at k<sub>G</sub> = 1`;
}
const cov = await import('../../src/domain/engine/coverage.ts');

// ------------------------------------------------------------------ values injected into the text ({{key}})
const V = {
  coverageNote: cov.coverageNote(), frEnsLeg: REP.ensVsLegacy.firstRack,
  judgedPert: REP.perturbed.judged.toLocaleString('en-US'), judgedPrior: REP.prior.judged.toLocaleString('en-US'), judgedLegacy: REP.legacy.judged.toLocaleString('en-US'),
  fitLoopM3: fitW,
  wpPeak12: f1(WPPEAK[12]), wpPeak5: f1(WPPEAK[5]), wpPeak4: f1(WPPEAK[4]),
  cfd60: f1(CFD[0.8].find((x) => x.t === 60).Ta), cfd300: f1(CFD[0.8].find((x) => x.t === 300).Ta), cfdKw: Math.round(cfdP / 1000), cfdRacks,
  ev24: EVW[24].pReal.toFixed(4), ev31: EVW[31].pReal.toFixed(2), lr31: EVW[31].logLR ? Math.exp(EVW[31].logLR).toFixed(1) : '', leakWet: leakWet.toFixed(3),
  sInst: EM.sigmaInstalled.value, sRef: EM.sigmaRef.value, sSp: EM.sigmaSpatial.value, sModel: EM.sigmaModel.value, nu: EM.nu.value,
  covLegacy: REP.legacy.coverage, covPrior: REP.prior.coverage, covPert: REP.perturbed.coverage, covEnsLeg: REP.ensVsLegacy.coverage,
  frLegacy: REP.legacy.firstRack, frPrior: REP.prior.firstRack, frPert: REP.perturbed.firstRack,
  secLegacy: REP.legacy.seconds, secPrior: REP.prior.seconds, secPert: REP.perturbed.seconds, secEnsLeg: REP.ensVsLegacy.seconds,
  errLegacy: REP.legacy.p50err, errPrior: REP.prior.p50err, errPert: REP.perturbed.p50err, errEnsLeg: REP.ensVsLegacy.p50err,
  biasLegacy: REP.legacy.bias, biasPrior: REP.prior.bias, biasPert: REP.perturbed.bias, biasEnsLeg: REP.ensVsLegacy.bias,
  faLegacy: REP.legacy.falseAlarms, faPrior: REP.prior.falseAlarms, faPert: REP.perturbed.falseAlarms, faEnsLeg: REP.ensVsLegacy.falseAlarms,
  lossesLegacy: REP.legacy.losses.toLocaleString('en-US'), lossesPrior: REP.prior.losses.toLocaleString('en-US'), lossesPert: REP.perturbed.losses.toLocaleString('en-US'),
};

// Start page of each section, read off the rendered PDF (Chromium has no target-counter()); re-check after edits.
const PAGES = { p1: 3, p2: 4, p3: 5, p4: 9, p5: 11, p6: 12, p7: 15, p8: 17 };
Object.assign(V, PAGES);

// ------------------------------------------------------------------ assemble
const css = readFileSync(join(HERE, 'style.css'), 'utf8');
const parts = readdirSync(join(HERE, 'content')).filter((f) => f.endsWith('.html')).sort();
let body = parts.map((f) => readFileSync(join(HERE, 'content', f), 'utf8')).join('\n');
body = body.replace(/<!--CHART:(\w+)-->/g, (_, k) => { if (!CH[k]) throw new Error(`unknown chart ${k}`); return CH[k]; });
body = body.replace(/\{\{(\w+)\}\}/g, (_, k) => { if (V[k] === undefined) throw new Error(`unknown value ${k}`); return esc(V[k]); });
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CenterGuard Prediction Science</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=IBM+Plex+Serif:wght@400;500&display=block" rel="stylesheet">
<style>${css}</style></head><body>
${body}
</body></html>`;
writeFileSync(OUT_HTML, html);
console.log(`wrote ${OUT_HTML} (${(html.length / 1024).toFixed(0)} KB)`);

if (!process.argv.includes('--html-only')) await printPdf();

/**
 * Print with headless Edge/Chrome over the DevTools protocol, so the PDF is made only after every
 * IBM Plex face has loaded (a plain --print-to-pdf sometimes prints with fallback fonts, which
 * changes the pagination). Uses a throw-away profile in the OS temp folder.
 */
async function printPdf() {
  const { spawn } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const browser = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
  const port = 9361;
  const proc = spawn(browser, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + port, '--user-data-dir=' + join(tmpdir(), 'centerguard-pdf-profile'), 'about:blank'], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let tabs = [];
    for (let i = 0; i < 100 && !tabs.length; i++) { try { tabs = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).filter((t) => t.type === 'page'); } catch { /* not up yet */ } if (!tabs.length) await sleep(150); }
    const ws = new WebSocket(tabs[0].webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
    await send('Page.enable');
    await send('Page.navigate', { url: 'file:///' + OUT_HTML.split(String.fromCharCode(92)).join('/') });
    const faces = ['300 12px "IBM Plex Sans"', '400 12px "IBM Plex Sans"', 'italic 400 12px "IBM Plex Sans"', '500 12px "IBM Plex Sans"', '600 12px "IBM Plex Sans"', '400 12px "IBM Plex Mono"', '500 12px "IBM Plex Mono"', '600 12px "IBM Plex Mono"', '400 12px "IBM Plex Serif"', '500 12px "IBM Plex Serif"'];
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      ok = await evaluate('(async () => { if (document.readyState !== "complete") return false; const f = ' + JSON.stringify(faces) + '; await Promise.all(f.map((x) => document.fonts.load(x).catch(() => null))); await document.fonts.ready; return f.every((x) => document.fonts.check(x)); })()');
      if (!ok) await sleep(500);
    }
    if (!ok) throw new Error('IBM Plex fonts did not load (network?); refusing to print with fallback fonts');
    const pdf = await send('Page.printToPDF', { preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
    writeFileSync(OUT_PDF, Buffer.from(pdf.result.data, 'base64'));
    ws.close();
    console.log('wrote ' + OUT_PDF + ' (' + (statSync(OUT_PDF).size / 1024).toFixed(0) + ' KB)');
  } finally { proc.kill(); }
}
