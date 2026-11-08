// Times the existing engine (read-only import) to size the trial budget for the dossier.
import { simulateScenario } from '../../src/domain/engine/simulate';
import { runCascade } from '../../src/domain/engine/cascade';
import { facility, seedReadings } from '../../src/domain/fixture';
import { getScenario } from '../../src/domain/scenarios';
const seeds = seedReadings();
for (const id of ['scn-riser-leak', 'scn-chiller-trip', 'real-azure-syd-2023']) {
  const scenario = getScenario(id)!;
  for (const runs of [1, 400, 2000]) {
    const t0 = performance.now();
    const r = simulateScenario({ facility, scenario, seedReadings: seeds, runs });
    const ms = performance.now() - t0;
    console.log(id, 'runs', runs, 'ms', ms.toFixed(1), 'clocks', Object.keys(r.clocks).length);
  }
}
const sc = getScenario('scn-chiller-trip')!;
let t0 = performance.now();
for (let s = 0; s < 50; s++) runCascade(facility, sc.faults, { horizonMin: sc.horizonMin, runs: 400, seed: s });
console.log('runCascade 400 runs avg ms', ((performance.now() - t0) / 50).toFixed(2));
t0 = performance.now();
for (let s = 0; s < 200; s++) runCascade(facility, sc.faults, { horizonMin: sc.horizonMin, runs: 50, seed: s });
console.log('runCascade 50 runs avg ms', ((performance.now() - t0) / 200).toFixed(2));
