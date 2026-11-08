/**
 * Simulation — a what-if lab, not a scripted scenario. Pick equipment, change one value, and the
 * engine predicts the future from the real propagation model. Nemotron explains the result when a
 * key is configured; otherwise the local planner answers and says so.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { SimulationFeedback, type SimulationPhase } from '../components/SimulationFeedback';
import { facility, seedReadings } from '../domain/fixture';
import { simulateScenario } from '../domain/engine';
import type { Reading } from '../domain/types';
import { Twin } from '../twin/Twin';
import { useOps } from '../state/store';
import { assetById, honestVisual } from '../state/selectors';
import { severityFor } from '../domain/engine/readings';
import { inletTempAt } from '../domain/engine/thermal';
import { plainAsset } from './plain';

const METRICS = [
  { metric: 'inlet_temp_c' as const, label: 'Temperature', unit: '°C', min: 15, max: 45, step: 0.5 },
  { metric: 'vibration_mm_s' as const, label: 'Vibration', unit: 'mm/s', min: 0, max: 12, step: 0.1 },
  { metric: 'humidity_rh' as const, label: 'Moisture', unit: '% RH', min: 10, max: 95, step: 1 },
];

const SEED = seedReadings();

export function Simulation() {
  const { state, scenario } = useOps();
  const assets = useMemo(() => {
    const ids = [...new Set(SEED.map((r) => r.assetId))].filter((id) => /^CRAH|^A-|^PIPE|^BATT/.test(id));
    return ids.slice(0, 12);
  }, []);
  const [assetId, setAssetId] = useState(assets[0] ?? 'CRAH-2');
  const [metric, setMetric] = useState<(typeof METRICS)[number]['metric']>('vibration_mm_s');
  const m = METRICS.find((x) => x.metric === metric)!;

  const baseReading = SEED.find((r) => r.assetId === assetId && r.metric === metric);
  const [value, setValue] = useState<number>(() => baseReading?.value ?? 3);
  const [explain, setExplain] = useState<{ text: string; provider: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<SimulationPhase>('idle');
  const [previewMinute, setPreviewMinute] = useState(15);
  const request = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);
  useEffect(() => () => { requestVersion.current++; request.current?.abort(); }, []);
  const clearRequest = () => { requestVersion.current++; request.current?.abort(); setBusy(false); setPhase('idle'); setExplain(null); };

  const pickAsset = (id: string) => {
    setAssetId(id);
    clearRequest();
    const r = SEED.find((x) => x.assetId === id && x.metric === metric);
    setValue(r?.value ?? m.step * 10);
  };
  const pickMetric = (next: typeof metric) => {
    setMetric(next);
    clearRequest();
    const def = METRICS.find((x) => x.metric === next)!;
    const r = SEED.find((x) => x.assetId === assetId && x.metric === next);
    setValue(r?.value ?? def.step * 10);
  };

  // Today's forecast with the readings as they are, so the tiles can show what this value changes.
  const baseline = useMemo(() => {
    const result = simulateScenario({ facility, scenario, seedReadings: SEED, runs: 120 });
    const lost = Object.values(result.clocks).filter((c) => c.p50 != null);
    return { racks: lost.filter((c) => assetById.get(c.assetId)?.type === 'rack').length };
  }, [scenario]);

  const limit = facility.thresholds.find((t) => t.metric === metric);
  const sev = severityFor(metric, value, facility.thresholds);
  const overAlarm = sev === 'critical';

  // The engine forecasts from the value you set: an alarm-level value becomes a fault at t=0 for
  // this asset, so the cascade and the thermal curve answer from the reading — no scripted scenario.
  const prediction = useMemo(() => {
    const override: Reading = {
      id: 'WHATIF-1', assetId, metric, value, unit: m.unit, t: 0, source: 'simulated', expectedIntervalMin: 5,
    };
    const seeds = SEED.filter((r) => !(r.assetId === assetId && r.metric === metric)).concat(override);
    const result = simulateScenario({
      facility, scenario, seedReadings: seeds, runs: 120,
      extraFaults: overAlarm ? [{ assetId, t: 0 }] : [],
    });
    const lost = Object.values(result.clocks)
      .filter((c) => c.p50 != null)
      .sort((a, b) => a.p50! - b.p50!);
    const racks = lost.filter((c) => assetById.get(c.assetId)?.type === 'rack');
    const load = assetById.get(assetId)?.loadKw;
    const tempAtHorizon = metric === 'inlet_temp_c' && load
      ? Math.round(inletTempAt(value, load, 0, scenario.horizonMin) * 10) / 10
      : null;
    return {
      result,
      firstAny: lost[0],
      racks: racks.length,
      horizon: scenario.horizonMin,
      affected: lost.length,
      tempAtHorizon,
      sev,
      extraRacks: Math.max(0, racks.length - baseline.racks),
    };
  }, [assetId, metric, value, m.unit, scenario, overAlarm, sev, baseline]);

  const askNemotron = async () => {
    if (busy) return;
    const version = ++requestVersion.current;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 90_000);
    setBusy(true); setPhase('running'); setExplain(null);
    try {
      const res = await fetch('/api/director', {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scenarioId: state.scenarioId, t: 0, incidents: [],
          question: `${plainAsset(assetId)} ${m.label.toLowerCase()} is ${value}${m.unit}. What is likely to happen in the next hour, and what is the first thing to do?`,
        }),
      });
      const data = await res.json() as { summary?: string; recommendation?: { summary?: string; nextAction?: string }; provider?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Analysis request failed (${res.status})`);
      if (version !== requestVersion.current) return;
      const text = data.summary ?? data.recommendation?.summary ?? data.recommendation?.nextAction ?? data.error ?? 'No explanation returned.';
      setExplain({ text, provider: data.provider === 'nemotron' ? 'Nemotron' : 'local planner' });
      setPhase('complete');
    } catch (e) {
      if (version !== requestVersion.current) return;
      setPhase('error');
      setExplain({ text: controller.signal.aborted ? 'The request timed out. Check the bridge and retry.' : (e as Error).message, provider: 'unavailable' });
    } finally {
      window.clearTimeout(timeout);
      if (version === requestVersion.current) setBusy(false);
    }
  };

  return (
    <div className="mon">
      <header className="mon-head">
        <div className="mon-health"><h1>What if</h1></div>
        <span className="mon-fact">Engine forecast · {scenario.horizonMin} min window</span>
      </header>

      <div className="mon-grid">
        <aside className="mon-list" aria-label="Equipment">
          <header className="mon-pane-h"><h2>Equipment</h2></header>
          <ol className="mon-items">
            {assets.map((id) => (
              <li key={id}>
                <button className={`mon-item ${id === assetId ? 'is-active' : ''}`} onClick={() => pickAsset(id)}>
                  <span className="mon-item-body"><span className="mon-item-title">{plainAsset(id)}</span></span>
                </button>
              </li>
            ))}
          </ol>
        </aside>

        <section className="mon-map cg-lab-map" aria-label="Modelled effect of the change">
          <div className="cg-lab-preview"><div><strong>Model preview</strong><small>Forecast, not live observations</small></div><div className="cg-lab-horizon" aria-label="Forecast horizon">{[0, 15, 30, 60].filter(n => n <= scenario.horizonMin).map(n => <button key={n} className={previewMinute === n ? 'is-active' : ''} aria-pressed={previewMinute === n} onClick={() => setPreviewMinute(n)}>{n === 0 ? 'Now' : `+${n} min`}</button>)}</div></div>
          {busy && <div className="mw-map-request"><span className="cg-request-spinner" aria-hidden="true"/>Explaining the model for {plainAsset(assetId)}</div>}
          <div className="mon-canvas">
            <Twin
              facility={facility}
              visual={honestVisual(prediction.result, scenario, previewMinute, previewMinute)}
              t={previewMinute}
              now={state.t}
              run={prediction.result}
              water={prediction.result.water}
              lookaheadMin={0}
              selectedId={assetId}
              onSelect={(id) => id && pickAsset(id)}
              employees={state.employees}
              layers={{ heat: false, water: false, deps: true, people: false }}
              resetViewKey={0}
            />
          </div>
          <footer className="mon-legend"><span>{plainAsset(assetId)}</span></footer>
        </section>

        <aside className="mon-side" aria-label="What-if controls">
          <div className="whatif">
            <div className="whatif-row">
              <span className="big-metric-k">Change</span>
              <div className="whatif-segs">
                {METRICS.map((x) => (
                  <button key={x.metric} className={`mon-chip ${x.metric === metric ? 'is-on' : ''}`} onClick={() => pickMetric(x.metric)}>{x.label}</button>
                ))}
              </div>
            </div>
            <label className="whatif-value">
              <input type="range" min={m.min} max={m.max} step={m.step} value={value} onChange={(e) => { clearRequest(); setValue(+e.target.value); }} />
              <span className="big-metric-v mono">{value.toFixed(m.step < 1 ? 1 : 0)}<small>{m.unit}</small></span>
            </label>

            <div className="big-metrics">
              <div className="big-metric">
                <span className="big-metric-k">{prediction.sev === 'critical' ? 'In alarm now' : 'Limit'}</span>
                <span className="big-metric-v mono">{limit ? limit.alarm : '—'}<small>{m.unit}</small></span>
                <span className="big-metric-who">{prediction.sev === 'normal' ? 'Inside limit' : prediction.sev === 'warning' ? 'Over warning' : 'At alarm — modeled as failed now'}</span>
              </div>
              <div className="big-metric">
                <span className="big-metric-k">Extra racks lost in {prediction.horizon} min</span>
                <span className="big-metric-v mono">{prediction.extraRacks}<small>racks</small></span>
                <span className="big-metric-who">{prediction.racks} of 60 in total</span>
              </div>
              <div className="big-metric">
                <span className="big-metric-k">First impact</span>
                <span className="big-metric-v mono">
                  {prediction.firstAny?.p50 != null ? Math.max(0, Math.round(prediction.firstAny.p50)) : '—'}
                  <small>min</small>
                </span>
                {prediction.firstAny && <span className="big-metric-who">{plainAsset(prediction.firstAny.assetId)}</span>}
              </div>
              <div className="big-metric">
                <span className="big-metric-k">Rack inlet at +{prediction.horizon} min</span>
                <span className="big-metric-v mono">{prediction.tempAtHorizon != null ? prediction.tempAtHorizon : '—'}<small>{prediction.tempAtHorizon != null ? '°C' : 'set a temp'}</small></span>
                <span className="big-metric-who">Thermal model, no cooling</span>
              </div>
            </div>

            <button className="btn btn-primary cg-simulation-button" onClick={askNemotron} disabled={busy} aria-busy={busy}>
              {busy ? <><span className="cg-request-spinner" aria-hidden="true"/>Requesting model explanation…</> : phase === 'error' ? 'Retry explanation' : phase === 'complete' ? 'Explain model again' : 'Explain model result'}
            </button>
            <SimulationFeedback phase={phase} subject={`${plainAsset(assetId)} at ${value} ${m.unit}`} message={phase === 'error' ? explain?.text : undefined} />
            {explain && (
              <div className="whatif-explain">
                <span className="mon-sub">{explain.provider}</span>
                <p>{explain.text}</p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
