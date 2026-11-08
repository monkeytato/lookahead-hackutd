import { SCENARIO_WALL_START } from './fixture';

/**
 * Scenario minute → wall-clock "HH:MM" (minute 0 = SCENARIO_WALL_START). Floors, like every
 * "T+n" label: at T+41.6 both read the 41st minute (02:51), never 02:52 next to "T+41".
 * Pure (no React), so the bridge and tests can share it.
 */
export function wallClock(t: number): string {
  const total = SCENARIO_WALL_START.h * 60 + SCENARIO_WALL_START.m + Math.floor(t + 1e-9);
  const h = Math.floor((((total / 60) % 24) + 24) % 24);
  const m = ((total % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
