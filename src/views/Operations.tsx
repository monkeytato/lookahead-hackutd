/**
 * Operations — the facility at rest. Every asset is instrumented, every reading is normal, and the
 * left panel is a sensor key: pick a sensor to mark every asset across the hall that reports it.
 * Simulation lives in its own tab; nothing here moves with a what-if run.
 */
import { useMemo, useState } from 'react';
import { facility } from '../domain/fixture';
import { sensorBaseline, sensorInventory } from '../domain/sensors';
import { severityFor } from '../domain/engine';
import type { AssetVisualState, Metric, Reading, Severity } from '../domain/types';
import { Twin, type TwinLayers } from '../twin/Twin';
import { useOps, type Selection } from '../state/store';
import { assetById, METRIC_LABEL } from '../state/selectors';
import { plainAsset } from './plain';

type Word = 'Critical' | 'Watch' | 'Normal' | 'No reading';
const RANK: Record<Severity, number> = { normal: 0, advisory: 0, warning: 1, critical: 2 };
const SEV_RANK: Record<Severity, number> = { normal: 0, advisory: 1, warning: 2, critical: 3 };
const WORD_OF: Record<Severity, Word> = { normal: 'Normal', advisory: 'Normal', warning: 'Watch', critical: 'Critical' };

const BIG = [
  { key: 'Temperature', metrics: ['inlet_temp_c', 'supply_temp_c', 'battery_temp_c'] as Metric[] },
  { key: 'Vibration', metrics: ['vibration_mm_s'] as Metric[] },
  { key: 'Moisture', metrics: ['humidity_rh'] as Metric[] },
];

const SYSTEMS = [
  { id: 'cooling', name: 'Cooling', test: (id: string) => /^CRAH|^CDU|^CH-|^PUMP/.test(id) },
  { id: 'power', name: 'Power', test: (id: string) => /^(UPS|BATT|ATS|GEN|PDU)/.test(id) },
  { id: 'water', name: 'Water', test: (id: string) => /^(PIPE|DRAIN)/.test(id) },
  { id: 'racks', name: 'Racks', test: (id: string) => /^(RACK|A-\d)/.test(id) },
];

function wordFor(r: Reading | undefined): Word {
  if (!r) return 'No reading';
  const sev = severityFor(r.metric, r.value, facility.thresholds);
  return WORD_OF[sev];
}

/** Clean visual state from the instrument baseline: every asset fresh, nothing lost. */
function baselineVisual(): Record<string, AssetVisualState> {
  const out: Record<string, AssetVisualState> = {};
  for (const asset of facility.assets) {
    let severity: Severity = 'normal';
    let heat = 0;
    for (const r of sensorBaseline(facility)) {
      if (r.assetId !== asset.id) continue;
      const s = severityFor(r.metric, r.value, facility.thresholds);
      if (SEV_RANK[s] > SEV_RANK[severity]) severity = s;
      if (r.metric === 'inlet_temp_c') heat = Math.min(1, Math.max(0, (r.value - 18) / 14));
    }
    out[asset.id] = { severity, freshness: 'fresh', heat };
  }
  return out;
}

export function Operations() {
  const { state } = useOps();
  const [sel, setSel] = useState<Selection>(null);
  const [markMetric, setMarkMetric] = useState<Metric | null>(null);
  const [layers, setLayers] = useState<TwinLayers>({ heat: false, water: false, deps: true, people: false });
  const [resetKey, setResetKey] = useState(0);

  const readings = useMemo(() => sensorBaseline(facility), []);
  const sensors = useMemo(() => sensorInventory(facility), []);
  const visual = useMemo(() => baselineVisual(), []);

  const marked = sensors.find((s) => s.metric === markMetric);

  const metrics = BIG.map((b) => {
    const rows = readings.filter((r) => b.metrics.includes(r.metric) && Number.isFinite(r.value));
    const worst = rows.reduce<Reading | undefined>((acc, r) => (!acc || r.value > acc.value ? r : acc), undefined);
    return { ...b, worst, word: wordFor(worst) };
  });

  const systems = useMemo(() => SYSTEMS.map((s) => {
    const rs = readings.filter((r) => s.test(r.assetId));
    const worst = rs.reduce<Severity>((acc, r) => {
      const sev = severityFor(r.metric, r.value, facility.thresholds);
      return SEV_RANK[sev] > SEV_RANK[acc] ? sev : acc;
    }, 'normal');
    return { ...s, worst, first: rs[0]?.assetId };
  }), [readings]);

  const overall = systems.reduce<Word>((acc, s) => (RANK[s.worst] > RANK[overallToSeverity(acc)] ? WORD_OF[s.worst] : acc), 'Normal');
  const selectedAsset = sel?.kind === 'asset' ? assetById.get(sel.id) : undefined;
  const selectedReadings = selectedAsset ? readings.filter((r) => r.assetId === selectedAsset.id) : [];

  return (
    <div className="mon">
      <header className="mon-head">
        <div className="mon-health">
          <h1>Hall A <span className={`word word-${overall.toLowerCase()}`}>{overall}</span></h1>
        </div>
        <span className="mon-fact">All sensors normal · simulated readings</span>
      </header>

      <div className="mon-grid">
        <aside className="mon-list" aria-label="Sensor key">
          <header className="mon-pane-h">
            <h2>Sensors</h2>
            <span className="mon-sub">{facility.assets.length} assets</span>
          </header>
          <ol className="mon-items">
            {sensors.map((s) => (
              <li key={s.metric}>
                <button
                  className={`sen-item ${s.metric === markMetric ? 'is-on' : ''}`}
                  aria-pressed={s.metric === markMetric}
                  onClick={() => setMarkMetric(s.metric === markMetric ? null : s.metric)}
                >
                  <i className="sen-dot" aria-hidden="true" />
                  <span className="sen-label">{s.label}</span>
                  <span className="sen-count mono">{s.assetIds.length}</span>
                </button>
              </li>
            ))}
          </ol>
        </aside>

        <section className="mon-map" aria-label="Hall A facility map">
          <div className="mon-canvas">
            <Twin
              facility={facility}
              visual={visual}
              t={0}
              now={state.t}
              selectedId={sel?.kind === 'asset' ? sel.id : null}
              onSelect={(id) => setSel(id ? { kind: 'asset', id } : null)}
              employees={state.employees}
              layers={layers}
              resetViewKey={resetKey}
              markIds={marked?.assetIds ?? []}
            />
          </div>
          <footer className="mon-legend">
            <button className="mon-chip" onClick={() => setLayers({ ...layers, deps: !layers.deps })}>Connections</button>
            <button className="mon-chip" onClick={() => setResetKey((n) => n + 1)}>Reset view</button>
            <span className="mon-legend-hint">
              {marked ? `${marked.label} · ${marked.assetIds.length} marked` : selectedAsset ? plainAsset(selectedAsset.id) : 'Select a sensor or equipment'}
            </span>
          </footer>
        </section>

        <aside className="mon-side" aria-label="Vitals">
          <div className="big-metrics">
            {metrics.map((m) => (
              <div key={m.key} className="big-metric">
                <span className="big-metric-k">{m.key}</span>
                <span className="big-metric-v mono">
                  {m.worst ? m.worst.value : '—'}<small>{m.worst?.unit ?? ''}</small>
                </span>
                <span className={`word word-${m.word.toLowerCase()}`}>{m.word}</span>
                {m.worst && <span className="big-metric-who">{plainAsset(m.worst.assetId)}</span>}
              </div>
            ))}
          </div>
          {selectedAsset && (
            <section className="resp-sec">
              <div className="resp-sec-h"><h3>{plainAsset(selectedAsset.id)}</h3></div>
              <ul className="mini-reads">
                {selectedReadings.map((r) => (
                  <li key={r.id}>
                    <span>{METRIC_LABEL[r.metric] ?? r.metric}</span>
                    <b className="mono">{Number.isFinite(r.value) ? r.value : '—'} <small>{r.unit}</small></b>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function overallToSeverity(w: Word): Severity {
  return w === 'Critical' ? 'critical' : w === 'Watch' ? 'warning' : 'normal';
}
