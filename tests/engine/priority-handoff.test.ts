import { describe, expect, it } from 'vitest';
import { POLICY_VERSION, buildHandoff, handoffToMarkdown, rankIncidents, runCascade } from '../../src/domain/engine';
import { employees, facility, seedIncidents, seedTasks } from '../../src/domain/fixture';
import type { VerificationSession } from '../../src/domain/types';

const clocks = runCascade(facility, [{ assetId: 'CRAH-2', t: 34 }], { horizonMin: 60 });

describe('rankIncidents (A08)', () => {
  const ranked = rankIncidents(seedIncidents(), { facility, clocks, now: 5, tasks: seedTasks(), employees });

  it('returns a factor breakdown with policyVersion, sorted desc', () => {
    expect(ranked).toHaveLength(2);
    expect(ranked[0].total).toBeGreaterThanOrEqual(ranked[1].total);
    for (const r of ranked) {
      expect(r.policyVersion).toBe(POLICY_VERSION);
      expect(r.factors.map((f) => f.key)).toEqual(['service', 'urgency', 'redundancy', 'evidence', 'resources', 'consequence']);
      expect(r.factors.reduce((s, f) => s + f.weight, 0)).toBeCloseTo(1, 6);
      for (const f of r.factors) {
        expect(f.score).toBeGreaterThanOrEqual(0);
        expect(f.score).toBeLessThanOrEqual(1);
        expect(f.note.length).toBeGreaterThan(5);
      }
      const sum = r.factors.reduce((s, f) => s + f.score * f.weight, 0);
      expect(r.total).toBeCloseTo(sum, 2);
    }
  });

  it('unverified incidents carry a resolvingCheck; CRAH-2 scores redundancy', () => {
    for (const r of ranked) expect(r.resolvingCheck).toBeTruthy();
    const crah = ranked.find((r) => r.incidentId === 'INC-1043')!;
    expect(crah.factors.find((f) => f.key === 'redundancy')!.score).toBe(1);
    expect(crah.resolvingCheck).toContain('TSK-202');
  });

  it('evidence keeps a floor for disagreement and drops resolvingCheck when corroborated', () => {
    const incs = seedIncidents();
    incs[0].evidence = 'measurement_disagreement';
    incs[1].evidence = 'corroborated_abnormal';
    const r = rankIncidents(incs, { facility, clocks, now: 5, tasks: seedTasks(), employees });
    const dis = r.find((x) => x.incidentId === 'INC-1042')!;
    expect(dis.factors.find((f) => f.key === 'evidence')!.score).toBeGreaterThan(0);
    expect(dis.resolvingCheck).toBeTruthy();
    expect(r.find((x) => x.incidentId === 'INC-1043')!.resolvingCheck).toBeUndefined();
  });
});

describe('buildHandoff', () => {
  it('summarizes from records with local_rules source', () => {
    const tasks = seedTasks();
    tasks[0] = { ...tasks[0], status: 'completed', ownerId: 'emp-marcus' };
    const v: VerificationSession = {
      id: 'VS-1', assetId: 'A-11', incidentId: 'INC-1042', operatorId: 'emp-marcus', probeId: 'PRB-01', point: 'A-11 front inlet, 1.6 m',
      metric: 'inlet_temp_c', installedReadingId: 'R-49', referenceReadingIds: ['REF-1'], t: 12, qualityFlags: [],
      verdict: 'measurement_disagreement', rationale: 'Measurement disagreement: …',
    };
    const note = buildHandoff({ now: 20, incidents: seedIncidents(), tasks, employees, events: [], verifications: [v], clocks, staleAssetIds: ['C-08'], facility });
    expect(note.source).toBe('local_rules');
    expect(note.generatedAt).toBe(20);
    expect(note.happening.length).toBe(2);
    expect(note.verified[0]).toContain('A-11');
    expect(note.uncertain.join(' ')).toContain('C-08');
    expect(note.done.join(' ')).toContain('TSK-201');
    expect(note.doNotRepeat.join(' ')).toContain('PRB-01');
    expect(note.watch[0].assetId).toBe('CRAH-2');
    expect(note.watch[0].atMin).toBe(34);
    const md = handoffToMarkdown(note, (t) => `T+${t}`);
    expect(md).toContain('# Shift handoff — T+20');
    expect(md).toContain('## Do not repeat');
  });
});
