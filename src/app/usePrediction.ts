/**
 * Forecast now (with ordered fixes) and, when fixes exist, the same forecast without them.
 * Both are FORECAST runs (audit C1): only faults observed or inferable at t, never the script's future.
 */
import { useMemo } from 'react';
import { facility, seedReadings } from '../domain/fixture';
import { useOps } from '../state/store';
import { hasObservedFault, liveForecast } from '../state/liveForecast';
import { useControls } from './controls';
import { forecast } from './forecast';

const SEED = seedReadings();

export function usePrediction() {
  const { state, forecast: run, scenario, activeExtraEdges } = useOps();
  const c = useControls();
  const t = state.t;
  const minute = Math.floor(t * 2) / 2;
  const now = useMemo(() => forecast(run, scenario, facility, minute), [run, scenario, minute]);
  const hasFixes = c.fixes.length > 0;
  // same observation state, no fixes: cached in liveForecast, so this is free between observations
  const baseRun = hasFixes ? liveForecast({ facility, scenario, seedReadings: SEED, t, extraEdges: activeExtraEdges }) : null;
  const without = useMemo(() => (baseRun ? forecast(baseRun, scenario, facility, minute) : null), [baseRun, scenario, minute]);
  /** false while nothing observed so far leads anywhere: show "watching", not a countdown */
  const observed = hasObservedFault(run, t);
  return { now, without, fixes: c.fixes, t, horizon: scenario.horizonMin, observed };
}
