import { describe, expect, it } from 'vitest';
import { simulateScenario } from '../../src/domain/engine';
import { facility, scenarios as fixtures, seedReadings } from '../../src/domain/fixture';
import {
  generateRandomScenario, getScenario, incidentsFor, isRandomScenario, listScenarios, randomScenarioId, realScenarios, seedOf, TEMPLATES,
} from '../../src/domain/scenarios';
import { mulberry32 } from '../../src/domain/engine/rng';
import type { Scenario } from '../../src/domain/types';

const run = (s: Scenario, runs = 80) => simulateScenario({ facility, scenario: s, seedReadings: seedReadings(), runs });
const hasClock = (s: Scenario) => Object.values(run(s).clocks).some((c) => c.p50 !== null && c.path.length > 1);
const assetIds = new Set(facility.assets.map((a) => a.id));

describe('registry', () => {
  it('fixture ids still resolve, unknown ids fall back', () => {
    for (const f of fixtures) expect(getScenario(f.id)).toBe(f);
    expect(getScenario('nope').id).toBe('scn-riser-leak');
  });

  it('lists the default demo first, then real incidents, with kind and headline', () => {
    const l = listScenarios();
    expect(l[0].id).toBe('scn-riser-leak');
    const ids = l.map((s) => s.id);
    for (const r of realScenarios) expect(ids).toContain(r.id);
    expect(l.filter((s) => s.kind === 'real').length).toBeGreaterThanOrEqual(5);
    for (const s of l) expect(s.headline.length).toBeGreaterThan(5);
    expect(ids.some(isRandomScenario)).toBe(false);
  });

  it('fixture incidents keep their ids', () => {
    const ids = fixtures.flatMap((f) => f.incidents ?? []).map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(['INC-1044', 'INC-1045', 'INC-2001', 'INC-3001', 'INC-3002']));
  });
});

describe('real incidents', () => {
  for (const s of realScenarios) {
    it(`${s.id} loads, names its source and produces a clock`, () => {
      expect(s.kind).toBe('real');
      expect(s.basis).toMatch(/simulated/i);
      expect(s.basis).toMatch(/adapted/i);
      expect(s.incidents!.length).toBeGreaterThan(0);
      for (const st of s.steps) expect(assetIds.has(st.assetId)).toBe(true);
      expect(hasClock(s)).toBe(true);
    });
  }
});

describe('random disasters', () => {
  const ids = Array.from({ length: 24 }, (_, i) => `rnd-${(i * 7919 + 13).toString(36)}`);

  it('the same id always builds the same disaster; different ids differ', () => {
    expect(JSON.stringify(generateRandomScenario('rnd-abc123'))).toBe(JSON.stringify(generateRandomScenario('rnd-abc123')));
    expect(getScenario('rnd-abc123')).toBe(getScenario('rnd-abc123'));
    const names = new Set(ids.map((id) => getScenario(id).name));
    expect(names.size).toBeGreaterThan(5);
    expect(seedOf('rnd-z')).toBe(35);
  });

  it('every generated scenario is presentable: a clock, incidents, sorted steps, valid ids', () => {
    for (const id of ids) {
      const s = getScenario(id);
      expect(s.id).toBe(id);
      expect(s.kind).toBe('random');
      expect(s.horizonMin).toBe(60);
      expect(s.basis).toContain(id);
      expect(s.incidents!.length).toBeGreaterThan(0);
      expect(s.steps.map((x) => x.t)).toEqual([...s.steps.map((x) => x.t)].sort((a, b) => a - b));
      for (const f of s.faults) expect(assetIds.has(f.assetId)).toBe(true);
      for (const i of s.incidents!) expect(i.openedAt).toBeLessThanOrEqual(60);
      expect(hasClock(s)).toBe(true);
    }
  });

  it('covers every template across seeds', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 80; i++) {
      const s = generateRandomScenario(`rnd-${(i * 104729 + 7).toString(36)}`);
      if (s.leak) seen.add('leak');
      if (s.hazards?.length) seen.add('ups_fire');
      if (s.faults.some((f) => f.assetId.startsWith('CH-'))) seen.add('chillers');
      if (s.faults.some((f) => f.assetId.startsWith('CRAH-'))) seen.add('crah');
      if (s.faults.some((f) => f.assetId === 'UTIL')) seen.add('power');
      if (s.faults.some((f) => f.assetId.startsWith('PDU-'))) seen.add('pdu');
    }
    expect([...seen].sort()).toEqual([...TEMPLATES].sort());
  });

  it('randomScenarioId makes rnd ids', () => {
    expect(randomScenarioId(mulberry32(1))).toMatch(/^rnd-[0-9a-z]+$/);
  });
});

describe('incidentsFor', () => {
  it('rebuilds the riser-leak water incident from the run', () => {
    const leak = getScenario('scn-riser-leak');
    const inc = incidentsFor(leak, run(leak));
    expect(inc.map((i) => i.id)).toEqual(['INC-1044', 'INC-1045']);
    expect(inc[1]).toMatchObject({ title: 'Water reached BATT-A — battery/UPS exposure', openedAt: 12 });
  });

  it('static incidents pass through for scenarios without water', () => {
    const gen = getScenario('scn-gen-nostart');
    expect(incidentsFor(gen, run(gen)).map((i) => i.id)).toEqual(['INC-2001']);
  });
});
