import { coverage, falseAlarmRate, meanAbsErr, meanBias, missRate, type Tally, type ValidationReport } from './harness';

const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)} %` : '—');
const min = (x: number) => (Number.isFinite(x) ? `${x.toFixed(1)} min` : '—');
const signed = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(1)} min` : '—');

export const tallyCols = ['losses', 'coverage p10–p90', 'p50 |error|', 'bias (real − p50)', 'missed', 'false alarms'];
export function tallyRow(t: Tally): string[] {
  return [String(t.realLosses), pct(coverage(t)), min(meanAbsErr(t)), signed(meanBias(t)), pct(missRate(t)), pct(falseAlarmRate(t))];
}

function table(head: string[], rows: string[][]): string {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  return [line(head), w.map((n) => '─'.repeat(n)).join('  '), ...rows.map(line)].join('\n');
}

function mdTable(head: string[], rows: string[][]): string {
  return [`| ${head.join(' | ')} |`, `| ${head.map((_, i) => (i ? '---:' : '---')).join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function sections(r: ValidationReport) {
  const overall = [['all', ...tallyRow(r.overall)]];
  const byKind = Object.entries(r.byKind).map(([k, t]) => [k, ...tallyRow(t)]);
  const byType = Object.entries(r.byType).sort((a, b) => b[1].realLosses - a[1].realLosses).map(([k, t]) => [k, ...tallyRow(t)]);
  const byScenario = r.scenarios
    .filter((s) => !s.id.startsWith('rnd-'))
    .map((s) => [s.id, ...tallyRow(s.tally), s.firstRackJudged ? pct(s.firstRackRight / s.firstRackJudged) : '—']);
  const fixes = r.scenarios.filter((s) => s.fix).map((s) => [
    s.id, `${s.fix!.label} (T+${s.fix!.orderedAt})`, String(s.fix!.predictedSaved), s.fix!.realizedSavedMean.toFixed(1), `${s.fix!.realizedSavedMin}–${s.fix!.realizedSavedMax}`, pct(s.fix!.withinTwo),
  ]);
  return { overall, byKind, byType, byScenario, fixes };
}

const FIX_COLS = ['scenario', 'best fix (ordered at)', 'predicted saved', 'realized mean', 'realized range', '|Δ| ≤ 2 racks'];

export function consoleReport(r: ValidationReport): string {
  const s = sections(r);
  const o = r.options;
  return [
    `Validation · ${r.scenarios.length} scenarios × ${o.iterations} iterations · perturb=${o.perturb} · seed=${o.seed} · ${(r.elapsedMs / 1000).toFixed(1)} s`,
    '',
    table(['', ...tallyCols], s.overall),
    '',
    'By scenario kind',
    table(['kind', ...tallyCols], s.byKind),
    '',
    'By asset type',
    table(['type', ...tallyCols], s.byType),
    '',
    'Named scenarios',
    table(['scenario', ...tallyCols, 'first rack right'], s.byScenario),
    '',
    `First rack right: ${pct(r.firstRack.right / r.firstRack.judged)} of ${r.firstRack.judged} judged iterations`,
    '',
    'Fixes (predicted vs realized racks saved)',
    table(FIX_COLS, s.fixes),
  ].join('\n');
}

export function markdownReport(r: ValidationReport): string {
  const s = sections(r);
  const o = r.options;
  const p = o.perturbation;
  return [
    `# Validation run — ${r.startedAt.slice(0, 10)}`,
    '',
    `${r.scenarios.length} scenarios (fixtures, real incidents, ${o.randomSeeds} random) × ${o.iterations} perturbed iterations each, perturbation **${o.perturb}**, seed ${o.seed}, ${(r.elapsedMs / 1000).toFixed(0)} s.`,
    '',
    `Perturbation: delays widened ±${p.widen * 100}% with a per-iteration bias of ±${p.bias * 100}%, start times ±${p.startJitterMin} min, leak/spread rates ±${p.rateSpread * 100}%, ${p.missedSignalP * 100}% chance a first signal is missed (up to ${p.missedLagMin} min extra detection lag).`,
    '',
    '## Overall',
    mdTable(['', ...tallyCols], s.overall),
    '',
    `First rack right: **${pct(r.firstRack.right / r.firstRack.judged)}** of ${r.firstRack.judged} judged iterations.`,
    '',
    `Fixes: ${r.fixes.checked} scenarios checked; predicted ${r.fixes.meanPredicted.toFixed(1)} racks saved on average vs **${r.fixes.meanRealized.toFixed(1)}** realized; realized within ±2 racks of the prediction in **${pct(r.fixes.withinTwo)}** of iterations.`,
    '',
    '## By scenario kind',
    mdTable(['kind', ...tallyCols], s.byKind),
    '',
    '## By asset type',
    mdTable(['type', ...tallyCols], s.byType),
    '',
    '## Named scenarios',
    mdTable(['scenario', ...tallyCols, 'first rack right'], s.byScenario),
    '',
    '## Fixes',
    mdTable(FIX_COLS, s.fixes),
    '',
    'Columns: *coverage* = share of realized losses inside the predicted p10–p90 (target ≈ 80 %); *p50 |error|* = mean absolute minutes between the realized loss and the predicted p50; *bias* > 0 means reality is slower than predicted; *missed* = realized losses the model did not predict within the horizon; *false alarms* = predicted losses that never happened.',
    '',
  ].join('\n');
}
