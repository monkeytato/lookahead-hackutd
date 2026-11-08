/** Forecast now (with ordered fixes) and, when fixes exist, the same forecast without them. */
import { useMemo } from 'react';
import { facility, seedReadings } from '../domain/fixture';
import { simulateScenario } from '../domain/engine';
import { useOps } from '../state/store';
import { useControls } from './controls';
import { forecast } from './forecast';

const SEED = seedReadings();

export function usePrediction() {
  const { state, run, scenario, activeExtraEdges } = useOps();
  const c = useControls();
  const t = state.t;
  const minute = Math.floor(t * 2) / 2;
  const now = useMemo(() => forecast(run, scenario, facility, minute), [run, scenario, minute]);
  const hasFixes = c.fixes.length > 0;
  const baseRun = useMemo(
    () => (hasFixes ? simulateScenario({ facility, scenario, seedReadings: SEED, extraEdges: activeExtraEdges }) : null),
    [hasFixes, scenario, activeExtraEdges],
  );
  const without = useMemo(() => (baseRun ? forecast(baseRun, scenario, facility, minute) : null), [baseRun, scenario, minute]);
  return { now, without, fixes: c.fixes, t, horizon: scenario.horizonMin };
}
