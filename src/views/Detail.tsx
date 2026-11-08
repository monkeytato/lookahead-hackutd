/**
 * The right-hand panel, shown only when something is selected: what it is, how long we have, what to
 * do. The full record (why chain, evidence, priority, tasks, director, readings) is one click away.
 */
import { facility } from '../domain/fixture';
import type { ImpactClock, PriorityResult } from '../domain/types';
import { useOps, type Selection } from '../state/store';
import { assetById, clocksForIncident, zoneById } from '../state/selectors';
import { impactLine } from '../app/forecast';
import { FixPanel } from './FixPanel';
import { Inspector } from './Inspector';

interface Props { sel: NonNullable<Selection>; setSel: (s: Selection) => void; clocks: ImpactClock[]; ranked: PriorityResult[] }

export function Detail({ sel, setSel, clocks, ranked }: Props) {
  const { state, forecast, scenario } = useOps();
  const t = state.t;
  const H = scenario.horizonMin;

  let kicker = '', title = '', what = '', time: { text: string; tone: string } | null = null, fixIds: string[] = [];
  if (sel.kind === 'incident') {
    const inc = state.incidents.find((i) => i.id === sel.id);
    if (!inc) return null;
    const a = assetById.get(inc.rootAssetId);
    kicker = inc.id;
    title = inc.title;
    what = a ? `${a.name} · ${zoneById.get(a.zoneId)?.name ?? ''}` : inc.rootAssetId;
    const imp = impactLine(clocksForIncident(inc, clocks), facility, t, H);
    time = { text: imp.text, tone: tone(imp.lost, imp.minutes) };
    fixIds = inc.status === 'resolved' ? [] : [inc.rootAssetId, ...inc.alertAssetIds];
  } else if (sel.kind === 'asset') {
    const a = assetById.get(sel.id);
    if (!a) return null;
    kicker = a.id;
    title = a.name;
    what = `${a.type.toUpperCase()} · ${zoneById.get(a.zoneId)?.name ?? ''}`;
    const c = forecast.clocks[a.id]; // a prediction: the forecast run, never the script (audit C1)
    if (c?.p50 != null && c.path.length > 1) {
      const left = c.p50 - t;
      time = left <= 0 ? { text: 'Lost', tone: 'is-critical' } : { text: `Lost in ${Math.max(1, Math.round(left))} min`, tone: tone(false, left) };
    } else time = { text: 'Not on a clock', tone: '' };
    fixIds = [a.id];
  }

  return (
    <div className="dt">
      <button className="dt-close" aria-label="Close" onClick={() => setSel(null)}>×</button>
      {title ? (
        <>
          <div className="dt-kicker mono">{kicker}</div>
          <h2 className="dt-title">{title}</h2>
          <p className="dt-what">{what}</p>
          {time && <div className={`dt-time ${time.tone}`}>{time.text}</div>}
          {fixIds.length > 0 && (
            <section className="dt-sec">
              <h3>Fix it</h3>
              <FixPanel assetIds={fixIds} />
            </section>
          )}
          <details className="dt-more">
            <summary>More details</summary>
            <Inspector sel={sel} setSel={setSel} clocks={clocks} ranked={ranked} brief />
          </details>
        </>
      ) : (
        <Inspector sel={sel} setSel={setSel} clocks={clocks} ranked={ranked} />
      )}
    </div>
  );
}

const tone = (lost: boolean, minutes: number | null) =>
  lost || (minutes != null && minutes <= 10) ? 'is-critical' : minutes != null && minutes <= 30 ? 'is-warning' : 'is-advisory';
