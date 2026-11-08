import { describe, expect, it } from 'vitest';
import { incidentPlayback, racksDownAt } from '../../src/domain/scenarios/playback';

describe('incident playback (3D replay of an evaluation)', () => {
  it('water leak: racks go down without a response and stay up with the valves closed', () => {
    const none = incidentPlayback('water', 0.9, null);
    const fix = incidentPlayback('water', 0.9, 'Close the isolation valves on PIPE-L2');
    expect(none.from).toBe(12);
    expect(racksDownAt(none, none.to)).toBeGreaterThan(0);
    expect(fix.fix?.assetId).toBe('PIPE-L2');
    expect(racksDownAt(fix, fix.to)).toBe(0);
    expect(none.run.water).toBeDefined();
  });
  it('an alarm judged not real plays without its effect (no leak)', () => {
    const p = incidentPlayback('water', 0.1, null);
    expect(p.run.water).toBeUndefined();
    expect(racksDownAt(p, p.to)).toBe(0);
  });
  it('an unknown response label plays the no-response run', () => {
    expect(incidentPlayback('heat', 0.9, 'not an option').fix).toBeUndefined();
  });
});
