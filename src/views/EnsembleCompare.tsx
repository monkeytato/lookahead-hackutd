/**
 * Ensemble detail for "2. Evaluate a response" (PREDICTION-SCIENCE.md §6 Step 6). Every number is
 * engine output and carries its basis. ISA-101: neutral by default; amber only for abnormal predicted
 * risk. Ranges are labelled "model range" until validation shows calibrated coverage.
 */
import type { EnsembleComparison, EnsembleSide } from '../domain/workflow';

const pct = (p: number) => (p < 0.001 ? '< 0.1 %' : p < 0.1 ? `${(p * 100).toFixed(1)} %` : `${Math.round(p * 100)} %`);
const oneIn = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} million` : n.toLocaleString('en-US'));
const minutes = (q: EnsembleSide['firstImpactMin'], horizon: number) => {
  if (!q || q.p50 === null) return q?.p10 != null ? `beyond ${horizon} min in most trials (p10 ${q.p10} min)` : `none within ${horizon} min`;
  return `${q.p50} min (model range ${q.p10 ?? '?'}–${q.p90 ?? `> ${horizon}`} min)`;
};
const abnormal = (s: EnsembleSide) => s.pServiceDown >= 0.1 || s.racksP50 > 0;

function Side({ title, s, horizon }: { title: string; s: EnsembleSide; horizon: number }) {
  return <div className={`mw-ens-side${abnormal(s) ? ' is-abnormal' : ''}`}>
    <small>{title}</small>
    <b>{s.racksP50} racks impacted</b>
    <small>model range {s.racksP10}–{s.racksP90} · mean {s.racksMean}</small>
    <span>Critical service down: P ≈ {pct(s.pServiceDown)}<small> (CI90 {pct(s.ci90[0])}–{pct(s.ci90[1])})</small></span>
    <span>Service impact (inlet ≥ 40–45 °C): {minutes(s.firstImpactMin, horizon)}</span>
    <span>Out of envelope (inlet ≥ 32 °C): {minutes(s.firstEnvelopeMin, horizon)}</span>
  </div>;
}

export function EnsembleCompare({ action, e }: { action: string; e: EnsembleComparison }) {
  const red = e.stress?.by === 'nemotron' ? 'Nemotron red team' : 'cross-entropy fallback (no Nemotron)';
  return <div className="mw-model-compare mw-ens">
    <strong>{action}</strong>
    <div>
      <Side title="Without response" s={e.without} horizon={e.horizonMin} />
      <Side title="With response" s={e.with} horizon={e.horizonMin} />
    </div>
    <small className="mw-ens-basis">Basis: physics model (room-air / IT-mass energy balance) with published failure priors and labelled assumptions, {e.trials.toLocaleString('en-US')} trials per option.</small>
    <p className="mw-ens-line">P(real) {e.pReal < 0.01 ? '< 0.01' : `= ${e.pReal.toFixed(2)}`}: probability the alarm reflects a real condition.<small> Evidence model, assumed error budget: {e.pRealBasis}.</small></p>
    {e.dominantFailure
      ? <p className="mw-ens-line">Biggest remaining risk: {e.dominantFailure.label} (about 1 in {oneIn(e.dominantFailure.priorOneIn)} incidents; {pct(e.dominantFailure.shareOfFailure)} of remaining risk).<small> Found by the {red}; prior from published rates or assumptions, share from the engine.</small></p>
      : <p className="mw-ens-line">Biggest remaining risk: no failing trials with this response.<small> Stress test by the {red}.</small></p>}
    {e.stress && <details><summary>Stress regions and their effect</summary>
      <p><small>With response after stress test: P(failure) ≈ {pct(e.stress.pFail)} (CI90 {pct(e.stress.ci90[0])}–{pct(e.stress.ci90[1])}), {e.stress.trials.toLocaleString('en-US')} re-weighted trials, ESS {e.stress.ess.toLocaleString('en-US')}, {e.stress.rounds} round{e.stress.rounds === 1 ? '' : 's'}. Proposals only steer sampling; every trial is re-weighted, so the estimate stays unbiased.</small></p>
      <ul className="mw-ens-regions">{e.stress.regions.map((r) => <li key={r.label}><span>{r.label}</span><small>prior ≈ 1 in {r.priorOneIn ? oneIn(r.priorOneIn) : '—'} · P(failure | region) {pct(r.pFailGivenRegion)} · share {pct(r.shareOfFailure)}</small></li>)}</ul>
      {e.stress.rejected > 0 && <small>{e.stress.rejected} proposed term{e.stress.rejected === 1 ? '' : 's'} rejected by the grammar check.</small>}
    </details>}
    <p className="mw-ens-line">{e.nextScan ? <>Measure next: {e.nextScan.point}.<small> {e.nextScan.why}; expected value {e.nextScan.evsi.toFixed(2)} rack-equivalents (engine, from the same trials).</small></> : <>Measure next: no portable scan would change the response.<small> The rig cannot measure this quantity, or no outcome changes the best action.</small></>}</p>
    <details><summary>Hypotheses weighted in the trials</summary><ul className="mw-ens-regions">{e.hypotheses.map((h) => <li key={h.label}><span>{h.label}</span><small>P = {h.p < 0.001 ? h.p.toExponential(1) : h.p.toFixed(3)} · {h.basisKind === 'published' ? 'published data' : h.basisKind === 'model' ? 'evidence model' : 'assumption'}</small></li>)}</ul></details>
    <small>{e.trials.toLocaleString('en-US')} trials · ESS {e.ess.toLocaleString('en-US')} · {e.provider === 'nemotron' ? 'Nemotron steered the stress test' : 'local planner'} · {e.coverageNote}</small>
  </div>;
}
