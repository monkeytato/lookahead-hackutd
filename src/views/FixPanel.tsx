/**
 * "Fix this": remediation options for an incident or asset, each with the engine's counterfactual
 * (run with vs. without the fix), an Order button that goes through the stage, and the status of
 * fixes already ordered. Used by the desktop inspector and the phone dashboard.
 */
import { useEffect, useMemo, useState } from 'react';
import { facility, seedReadings } from '../domain/fixture';
import { fixOptionsFor, makeFix, predictFix, type FixOption, type FixPrediction } from '../domain/engine/fixes';
import type { Fix, ID } from '../domain/types';
import { makeEvent, useOps } from '../state/store';
import { useControls } from '../app/controls';
import { describeFix } from '../app/forecast';

const SEED = seedReadings();
const key = (o: FixOption) => `${o.action}|${o.assetId}`;

export function FixPanel({ assetIds, compact }: { assetIds: ID[]; compact?: boolean }) {
  const { state, dispatch, scenario, run } = useOps();
  const c = useControls();
  const t = state.t;
  const minute = Math.floor(t);
  const ids = useMemo(() => [...new Set(assetIds)], [assetIds]);
  const fixesKey = c.fixes.map((f) => f.id).join(',');

  const options = useMemo(() => {
    const ctx = { facility, scenario, seedReadings: SEED, fixes: c.fixes, t: minute, run };
    const seen = new Set<string>();
    const out: FixOption[] = [];
    for (const id of ids) for (const o of fixOptionsFor(ctx, id)) if (!seen.has(key(o))) { seen.add(key(o)); out.push(o); }
    return out.filter((o) => !c.fixes.some((f) => f.assetId === o.assetId && f.action === o.action)).slice(0, compact ? 1 : 5);
    // fixesKey stands in for c.fixes (new array identity on every stage message)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, scenario, minute, fixesKey, compact, run]);

  // counterfactuals are a few engine runs each: compute after paint, one per frame
  const [preds, setPreds] = useState<Record<string, FixPrediction>>({});
  // engine-predicted impact captured when the fix was ordered, kept for the applied row
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    const ctx = { facility, scenario, seedReadings: SEED, fixes: c.fixes, t: minute };
    const queue = [...options];
    const next = () => {
      if (cancelled) return;
      const o = queue.shift();
      if (!o) return;
      try {
        const p = predictFix(ctx, o);
        setPreds((prev) => ({ ...prev, [`${key(o)}@${minute}`]: p }));
      } catch { /* leave it as "not available" */ }
      window.setTimeout(next, 0);
    };
    const id = window.setTimeout(next, 30);
    return () => { cancelled = true; window.clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, minute]);

  const ordered = c.fixes.filter((f) => ids.includes(f.assetId));
  const order = (o: FixOption) => {
    const fix = makeFix(o, t);
    const d = preds[`${key(o)}@${minute}`];
    if (d) setOutcomes((prev) => ({ ...prev, [fix.id]: describeFix(d).headline + ' · ' + describeFix(d).detail }));
    c.send({ type: 'fix', fix }); // the store writes "Fix ordered" / "Fix in effect" to the log
  };
  const cancel = (f: Fix) => {
    c.send({ type: 'unfix', fixId: f.id });
    dispatch({ type: 'append_event', event: makeEvent(t, { kind: 'task', actor: 'Priya Raman', summary: `Fix cancelled: ${f.label}`, links: { assetId: f.assetId }, source: 'operator' }) });
  };

  return (
    <div className={`fixes ${compact ? 'fixes-compact' : ''}`}>
      {ordered.length > 0 && (
        <ul className="fix-ordered">
          {ordered.map((f) => {
            const live = t >= f.effectiveAt;
            return (
              <li key={f.id} className={live ? 'is-live' : ''}>
                <span className={`fix-state ${live ? 'is-live' : ''}`}>{live ? 'Applied' : 'Pending'}</span>
                <span className="fix-label">{f.label}</span>
                <span className="fix-when">{live ? 'live in the model' : f.effectiveAt > scenario.horizonMin ? `needs ~${Math.round(f.effectiveAt - t)} min — beyond this window` : `ready in ~${Math.max(1, Math.ceil(f.effectiveAt - t))} min`}</span>
                {outcomes[f.id] && <span className="fix-outcome">{outcomes[f.id]}</span>}
                {!live && <button className="fix-cancel" onClick={() => cancel(f)}>Cancel</button>}
              </li>
            );
          })}
        </ul>
      )}
      {options.length === 0 && ordered.length === 0 && (
        <p className="mon-empty">No response available here yet. Verify the problem first, or select the equipment causing it.</p>
      )}
      {options.length > 0 && (
        <ul className="fix-options">
          {options.map((o) => {
            const p = preds[`${key(o)}@${minute}`];
            const d = p ? describeFix(p) : null;
            return (
              <li key={key(o)} className="fix-opt">
                <div className="fix-opt-h">
                  <span className="fix-label">{o.label}</span>
                  <span className="fix-delay">needs ~{o.delayMin} min</span>
                </div>
                {!compact && <p className="fix-desc">{o.description}</p>}
                <div className="fix-pred">
                  {d ? (
                    <>
                      <span className={`fix-head ${d.helps ? 'is-good' : ''}`}>{d.headline}</span>
                      <span className="fix-detail">{d.detail}</span>
                    </>
                  ) : <span className="fix-detail">Estimating impact…</span>}
                </div>
                <button className="btn btn-primary fix-go" disabled={!c.shared} title={c.shared ? 'Dispatch this response through the simulation stage' : 'Responses need the stage (open the workspace from #/app)'} onClick={() => order(o)}>
                  Apply fix
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!compact && <p className="muted small fix-foot">Predictions are engine counterfactuals: the same scenario run with and without the fix. Work times are assumptions.</p>}
    </div>
  );
}
