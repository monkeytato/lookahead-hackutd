/**
 * Twin lab (#/twin-lab): the live twin on its own, driven by the real engine. Pick any scenario
 * (fixtures, real-incident replays, random disasters), play it, preview the prediction, order a
 * fix and toggle presenter mode. Everything here is simulated.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Fix } from '../domain/types';
import { facility, employees, seedReadings, SCENARIO_WALL_START } from '../domain/fixture';
import { simulateScenario, fixOptionsFor, makeFix } from '../domain/engine';
import { getScenario, listScenarios, randomScenarioId } from '../domain/scenarios';
import { Twin, type TwinLayers } from './Twin';
import '../styles/tokens.css';
import './twin.css';

const wall = (t: number) => {
  const m = SCENARIO_WALL_START.h * 60 + SCENARIO_WALL_START.m + Math.floor(t);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export function TwinDemo() {
  const options = useMemo(() => listScenarios(), []);
  const [scenarioId, setScenarioId] = useState(options[0]?.id ?? 'scn-riser-leak');
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [lookahead, setLookahead] = useState(0);
  const [presenter, setPresenter] = useState(false);
  const [fixes, setFixes] = useState<Fix[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resetViewKey, setResetViewKey] = useState(0);
  const [layers, setLayers] = useState<TwinLayers>({ heat: false, water: true, deps: false, people: false });

  const scenario = useMemo(() => getScenario(scenarioId), [scenarioId]);
  const seeds = useMemo(() => seedReadings(), []);
  const run = useMemo(() => simulateScenario({ facility, scenario, seedReadings: seeds, fixes, runs: 200 }), [scenario, seeds, fixes]);
  const visual = useMemo(() => run.visualAt(Math.round(t * 2) / 2), [run, t]);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setT((x) => {
      const n = Math.min(scenario.horizonMin, +(x + 0.5).toFixed(1));
      if (n >= scenario.horizonMin) setPlaying(false);
      return n;
    }), 200);
    return () => window.clearInterval(id);
  }, [playing, scenario.horizonMin]);

  const pick = (id: string) => { setScenarioId(id); setT(0); setFixes([]); setPlaying(false); setSelectedId(null); };

  // first fix the engine offers on the scenario's own fault assets
  const fixOption = useMemo(() => {
    const roots = [...scenario.faults.map((f) => f.assetId), ...(scenario.hazards ?? []).map((h) => h.originAssetId), 'PIPE-L2'];
    for (const id of roots) {
      const o = fixOptionsFor({ facility, scenario, seedReadings: seeds, fixes, t }, id)[0];
      if (o) return o;
    }
    return null;
  }, [scenario, seeds, fixes, t]);

  const sel = selectedId ? facility.assets.find((a) => a.id === selectedId) : undefined;

  return (
    <div className="twin-demo">
      <Twin
        facility={facility}
        visual={visual}
        water={run.water}
        t={t}
        now={t}
        selectedId={selectedId}
        onSelect={setSelectedId}
        employees={employees}
        layers={layers}
        resetViewKey={resetViewKey}
        run={run}
        lookaheadMin={lookahead}
        presenter={presenter}
        buildKey={scenarioId}
      />
      <section className="twin-demo__panel" aria-label="Twin lab controls">
        <header>
          <div className="twin-demo__eyebrow">Twin lab · simulated</div>
          <div className="twin-demo__title">{scenario.headline ?? scenario.name}</div>
        </header>
        <label className="twin-demo__slider">
          <span>Scenario</span>
          <select value={scenarioId} onChange={(e) => pick(e.target.value)}>
            {options.map((o) => <option key={o.id} value={o.id}>{o.kind === 'real' ? 'Real · ' : ''}{o.name}</option>)}
            {scenarioId.startsWith('rnd-') && <option value={scenarioId}>Random · {scenario.name}</option>}
          </select>
        </label>
        <div className="twin-demo__row">
          <button type="button" className="twin-demo__btn" onClick={() => pick(randomScenarioId())}>Random disaster</button>
          <button type="button" className="twin-demo__btn" onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Play'}</button>
          <button type="button" className="twin-demo__btn" onClick={() => setT((x) => Math.min(scenario.horizonMin, x + 5))}>+5 min</button>
        </div>
        <label className="twin-demo__slider">
          <span>Scenario time <b className="mono">T+{t.toFixed(1)} min · {wall(t)}</b></span>
          <input type="range" min={0} max={scenario.horizonMin} step={0.5} value={t} onChange={(e) => setT(Number(e.target.value))} />
        </label>
        <label className="twin-demo__slider">
          <span>Prediction <b className="mono">{lookahead ? `+${lookahead} min` : 'off'}</b></span>
          <input type="range" min={0} max={30} step={5} value={lookahead} onChange={(e) => setLookahead(Number(e.target.value))} />
        </label>
        <div className="twin-demo__row">
          <button type="button" className="twin-demo__btn" disabled={!fixOption} onClick={() => fixOption && setFixes((f) => [...f, makeFix(fixOption, t)])}>
            {fixOption ? `Fix: ${fixOption.label}` : 'No fix available'}
          </button>
          {fixes.length > 0 && <button type="button" className="twin-demo__btn" onClick={() => setFixes([])}>Clear fixes</button>}
        </div>
        <fieldset>
          <legend>Layers</legend>
          {(Object.keys(layers) as (keyof TwinLayers)[]).map((k) => (
            <label key={k} className="twin-demo__check">
              <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers((l) => ({ ...l, [k]: e.target.checked }))} />
              {{ heat: 'Heat slice', water: 'Water', deps: 'Dependency path', people: 'People' }[k]}
            </label>
          ))}
          <label className="twin-demo__check">
            <input type="checkbox" checked={presenter} onChange={(e) => setPresenter(e.target.checked)} />
            Presenter mode
          </label>
        </fieldset>
        <div className="twin-demo__row">
          <button type="button" className="twin-demo__btn" onClick={() => setResetViewKey((k) => k + 1)}>Reset view</button>
          <span className="twin-demo__sel">{sel ? <><b className="mono">{sel.id}</b> {sel.name}</> : 'Nothing selected'}</span>
        </div>
      </section>
    </div>
  );
}

export default TwinDemo;
