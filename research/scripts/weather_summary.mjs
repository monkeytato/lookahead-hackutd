// Summarise DFW hourly weather (Open-Meteo archive + NOAA global-hourly) for the chiller-derate model.
// Reads CSV files as data only. Usage: node research/scripts/weather_summary.mjs <open-meteo.csv> <noaa1.csv> [noaa2.csv ...]
import { readFileSync, writeFileSync } from 'node:fs';

const [omPath, ...noaaPaths] = process.argv.slice(2);

const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
const r1 = (x) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------- Open-Meteo
const om = readFileSync(omPath, 'utf8').split(/\r?\n/);
const hdr = om.findIndex((l) => l.startsWith('time,'));
const rows = om.slice(hdr + 1).filter(Boolean).map((l) => {
  const [time, t, rh, dp, wb, p] = l.split(',');
  return { time, year: +time.slice(0, 4), month: +time.slice(5, 7), t: +t, rh: +rh, dp: +dp, wb: +wb, p: +p };
}).filter((r) => Number.isFinite(r.t));

const byYear = new Map();
for (const r of rows) { if (!byYear.has(r.year)) byYear.set(r.year, []); byYear.get(r.year).push(r); }

const yearly = [];
for (const [y, rs] of [...byYear].sort((a, b) => a[0] - b[0])) {
  const T = rs.map((r) => r.t).sort((a, b) => a - b);
  const W = rs.map((r) => r.wb).filter(Number.isFinite).sort((a, b) => a - b);
  const D = rs.map((r) => r.dp).sort((a, b) => a - b);
  yearly.push({
    year: y, hours: rs.length,
    tMax: r1(T[T.length - 1]), tMin: r1(T[0]),
    t99_6: r1(pct(T, 0.996)), t99: r1(pct(T, 0.99)), t98: r1(pct(T, 0.98)),
    hoursGe35: rs.filter((r) => r.t >= 35).length, hoursGe38: rs.filter((r) => r.t >= 38).length, hoursGe40: rs.filter((r) => r.t >= 40).length,
    wbMax: r1(W[W.length - 1]), wb99_6: r1(pct(W, 0.996)), wb99: r1(pct(W, 0.99)),
    dpMax: r1(D[D.length - 1]), hoursDpGe21: rs.filter((r) => r.dp >= 21).length,
    hoursLe_10: rs.filter((r) => r.t <= -10).length,
  });
}

// Monthly diurnal profile for the most recent full year (used to pick a scenario's ambient by hour)
const last = Math.max(...[...byYear.keys()].filter((y) => byYear.get(y).length > 8700));
const diurnal = {};
for (const r of byYear.get(last)) {
  const h = +r.time.slice(11, 13);
  const k = `${r.month}`;
  diurnal[k] ??= Array.from({ length: 24 }, () => ({ n: 0, s: 0, max: -99 }));
  const c = diurnal[k][h]; c.n++; c.s += r.t; c.max = Math.max(c.max, r.t);
}
const diurnalOut = Object.fromEntries(Object.entries(diurnal).map(([m, hs]) => [m, hs.map((c) => ({ mean: r1(c.s / c.n), max: r1(c.max) }))]));

// Chiller capacity-at-ambient exposure: an air-cooled chiller rated at 35 °C ambient loses roughly
// `derate` per °C above rating (parameter, see PREDICTION-SCIENCE.md). Count hours where capacity < 90 / 85 %.
const derateHours = (derate) => yearly.map((y) => {
  const rs = byYear.get(y.year);
  const cap = rs.map((r) => 1 - Math.max(0, r.t - 35) * derate);
  return { year: y.year, lt95: cap.filter((c) => c < 0.95).length, lt90: cap.filter((c) => c < 0.9).length, min: r1(Math.min(...cap) * 100) };
});

// ---------------------------------------------------------------- NOAA global-hourly (ISD)
function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}
const noaa = [];
for (const p of noaaPaths) {
  const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
  const h = parseCsvLine(lines[0]);
  const iDate = h.indexOf('DATE'), iTmp = h.indexOf('TMP'), iDew = h.indexOf('DEW'), iType = h.indexOf('REPORT_TYPE');
  const recs = [];
  for (const l of lines.slice(1)) {
    const f = parseCsvLine(l);
    if (f[iType]?.trim() !== 'FM-15') continue; // routine hourly METAR only
    const [tv, tq] = (f[iTmp] ?? '').split(',');
    const [dv, dq] = (f[iDew] ?? '').split(',');
    if (!tv || tv === '+9999' || !['1', '5'].includes(tq)) continue;
    recs.push({ date: f[iDate], t: +tv / 10, dp: dv && dv !== '+9999' && ['1', '5'].includes(dq) ? +dv / 10 : NaN });
  }
  const T = recs.map((r) => r.t).sort((a, b) => a - b);
  noaa.push({
    file: p.split(/[\\/]/).pop(), hourlyReports: recs.length, first: recs[0]?.date, last: recs[recs.length - 1]?.date,
    tMax: r1(T[T.length - 1]), tMin: r1(T[0]), t99_6: r1(pct(T, 0.996)), hoursGe35: recs.filter((r) => r.t >= 35).length, hoursGe40: recs.filter((r) => r.t >= 40).length,
    _recs: recs,
  });
}

// Cross-check Open-Meteo (reanalysis) against the airport station on matching hours (UTC vs local: NOAA DATE is UTC)
const omByUtc = new Map();
for (const r of rows) {
  // Open-Meteo times are America/Chicago; convert to UTC with the fixed -6 h offset reported in the header would ignore DST,
  // so we only compare daily maxima per local date instead (robust to the offset).
}
const omDailyMax = new Map();
for (const r of rows) { const d = r.time.slice(0, 10); omDailyMax.set(d, Math.max(omDailyMax.get(d) ?? -99, r.t)); }
const stDailyMax = new Map();
for (const n of noaa) for (const r of n._recs) {
  const utc = new Date(r.date + 'Z');
  const local = new Date(utc.getTime() - 6 * 3600e3).toISOString().slice(0, 10); // CST approx; daily max is insensitive to 1 h
  stDailyMax.set(local, Math.max(stDailyMax.get(local) ?? -99, r.t));
}
const diffs = [];
for (const [d, s] of stDailyMax) if (omDailyMax.has(d)) diffs.push(omDailyMax.get(d) - s);
diffs.sort((a, b) => a - b);
const crossCheck = { days: diffs.length, meanBiasC: r1(diffs.reduce((a, b) => a + b, 0) / diffs.length), p05: r1(pct(diffs, 0.05)), p95: r1(pct(diffs, 0.95)) };

const out = {
  generated: new Date().toISOString(),
  openMeteo: { file: omPath.split(/[\\/]/).pop(), hours: rows.length, years: yearly },
  diurnalYear: last, diurnalByMonth: diurnalOut,
  chillerDerateHours: { 'derate_1.0pct_per_C': derateHours(0.01), 'derate_1.5pct_per_C': derateHours(0.015), 'derate_2.0pct_per_C': derateHours(0.02) },
  noaa: noaa.map(({ _recs, ...x }) => x),
  crossCheckDailyMax_OpenMeteoMinusStation: crossCheck,
};
const dest = process.env.OUT;
if (dest) writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, diurnalByMonth: '(omitted)' }, null, 1));
