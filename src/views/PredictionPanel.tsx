/**
 * "If nothing changes": the engine's forecast for the rest of the horizon, in plain words, and —
 * once fixes are ordered — the same forecast without them, so the difference is visible.
 */
import { type Forecast } from '../app/forecast';
import { usePrediction } from '../app/usePrediction';
import { assetName } from '../state/selectors';

const rackLine = (f: Forecast, H: number, lower = false) => {
  const s = f.firstRack ? `First rack lost after ${Math.max(0, Math.round(f.firstRack.at))} min of incident time` : `No rack lost in this ${H}-min window`;
  return lower ? s[0].toLowerCase() + s.slice(1) : s;
};

export function PredictionPanel() {
  const p = usePrediction();
  const H = p.horizon;
  const f = p.now;
  const saved = p.without ? p.without.racksLost - f.racksLost : 0;
  return (
    <div className="pred" aria-live="polite">
      <div className="pred-h">
        <span className="pred-k">{p.fixes.length ? 'Response applied vs. none' : 'If nothing changes'}</span>
        <span className="pred-src mono">engine forecast · p50</span>
      </div>
      <div className="pred-main">{rackLine(f, H)}</div>
      <div className="pred-grid">
        <div><b className="mono">{f.racksLost}</b><span>racks lost by T+{H}</span></div>
        <div><b className="mono">{f.assetsLost}</b><span>assets lost in total</span></div>
      </div>
      {f.next && <div className="pred-next">Next: <b className="mono">{f.next.assetId}</b> {assetName(f.next.assetId) !== f.next.assetId ? `(${assetName(f.next.assetId)})` : ''} in {Math.max(0, Math.round(f.next.at - p.t))} min</div>}
      {f.servicesAtRisk.length > 0 && (
        <div className="pred-svc">At risk: {f.servicesAtRisk.slice(0, 3).map((s) => s.name).join(', ')}{f.servicesAtRisk.length > 3 ? ` +${f.servicesAtRisk.length - 3}` : ''}</div>
      )}
      {p.without && (
        <div className={`pred-delta ${saved > 0 ? 'is-good' : ''}`}>
          {saved > 0 ? `Response saves ${saved} rack${saved === 1 ? '' : 's'}` : 'Response changes no rack outcome yet'} · without it: {p.without.racksLost} racks, {rackLine(p.without, H, true)}
        </div>
      )}
    </div>
  );
}
