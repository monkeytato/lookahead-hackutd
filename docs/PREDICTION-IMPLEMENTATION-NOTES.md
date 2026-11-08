# Prediction overhaul: implementation log

Running log for resuming work. Spec: `docs/PREDICTION-SCIENCE.md` §6 (implementation plan) and §7 (validation plan).
Each step is finished green (`npm run typecheck`, `npm test`, `npm run lint`) before the next starts.

Baseline before any change (2026-11-07): typecheck clean, 21 test files / 232 tests pass, lint 0 errors
(existing warnings only), `reports/validation-2026-11-08-default.md`: p10–p90 coverage **24 %**.

## Decisions

- Forecast mode is **opt-in** for `simulateScenario` / `predictFix` (`mode: 'forecast'`). Stage, `#/present`,
  Facility and the phone keep the script run: relabelling those screens is outside this overhaul's UI scope
  (only MonitorWorkspace section 2 is touched). The director session, the workflow evaluate path and the
  ensemble always forecast.

## Steps

| Step | Status | Files |
| --- | --- | --- |
| 0 No foreknowledge | done (green, 237 tests) | `engine/observable.ts` (new), `engine/simulate.ts` (`mode`, `forecastAt`, `hypotheses`, `assumedFaults`), `engine/fixes.ts` (`FixContext.mode`, cache key C12, `fixOption`), `server/director/tools.ts` (session forecasts; `situation.hypotheses`), `tests/engine/observable.test.ts`, planner test now compares with the forecast run |
| 1 Evidence posterior | done (green, 249 tests) | `engine/evidence.ts` (new), `engine/verification.ts` (`compareWithPosterior`), `server/workflowHub.ts` (`verify_scan` uses the posterior; heat refused as not measurable; vibration capped at "motion present"; `simulatedTruth` for the sim rig), `server/index.ts` (sim spill/dry around a water scan), tests. Not done: `rig/scan.ts` `settled`/`extrapolatedC` (posterior uses the channel slope to flag `unsettled_lag` instead). Dossier test "31 °C → P > 0.95" was Gaussian; with ν = 4 it is 0.90 (test asserts > 0.88). |
| 2 Physics zone model + priors | done (green) | `engine/priors.ts` (typed distributions with quantile/cdf/logpdf; §3 families), `engine/thermalZone.ts` (port of `thermal_backtest.mjs`; closed-form fans-off, Euler fans-on; `zonesFor`, `zoneClocks` with the 32 °C and T_trip clocks), `tests/engine/thermalZone.test.ts` (WP179 Ex.1 fit + 5-min restart, CFD 60/300 s, energy conservation, fixture ranges). Not done: `thermal.ts inletTempAt` still the old curve (used only for display readings in `simulateScenario`); fixture `delaySource` field and BV-3 vibration thresholds (not in this overhaul's brief); ambient / chiller-derate families. |
| 3 Hierarchical ensemble | done (green, 266 tests) | `engine/cascade.ts` refactored to `compileGraph` + `runOnce` (bit-identical, checked on 6 scenarios), `engine/ensemble.ts` (outer θ × inner draws, physics delays on cooling edges, one draw per zone, on-demand failures, hypotheses stratified at 0.5 with p/b weights, defensive mixture hook, water bins with 1/rate scaling, hot-spot model for one rack, two clocks, weighted quantiles, cluster-level CI, `runEnsembleAsync` yields every 16 θ). Measured: 2 options × 2,048 trials 0.49 s cold (water cache) / 4 options 0.17 s warm (Node). Prior-predictive coverage test passes (72–88 % band). Not done: `predictFix.ensemble` field (evaluate path calls the ensemble directly). |
| 4a EVSI (engine) | done (green) | `engine/evsi.ts` (per-trial likelihoods; tie-break `forecastShift`), `tests/engine/evsi.test.ts` (A-11 first; leak floor scan above inlet; toy brute force 0.265). Finding: at riser T+12 isolating is best whatever one floor point reads, so every EVSI is 0 — honest; ranking falls back to how far the reading moves P(service down). |
| 5a Stress (engine) | done (green, 275 tests) | `engine/stress.ts` (grammar, mixture, digest, attribution, CE fallback, `stressTest`), `tests/engine/stress.test.ts` (bounded weights, rare event within 3 SE at N = 8,000, random proposals unbiased). |
| 6a Incident scenarios | done | `scenarios/incident.ts` (`incident-*` scenarios, `incidentModel(kind, pReal)`), resolvable by `getScenario`, not listed in `listScenarios`. |
| 4b/5b/6b Director + workflow | done (green, 282 tests) | `server/director/types.ts` (`DirectorInput.context`, `.evaluation`, `DirectorResult.evaluation`), `server/director/evaluation.ts` (new: get_context / stress_digest / stress_test tools, CE round, `evaluationOutput`, `dominantRegion`), `tools.ts` (signed shifts + `direction`, incident scenario lookup, context/evaluation sanitising, observed numbers, counts registered), `validate.ts` (PERCENT / COUNT / ODDS, stress-N ids, direction and provenance checks), `director.ts` (evaluation prompt + tools, 30 s cap), `planner.ts` (evaluation steps, engine-only narrative, EVSI next scan, UI yields), `workflowHub.ts` evaluate (incident scenario per kind, P(real) from evidence, structured context, `comparison.ensemble`), `src/domain/workflow.ts` (optional `EnsembleComparison`), `engine/coverage.ts`. Tests: `tests/director/stress.test.ts`, workflow evaluate tests. Deviation: `scan_value.decisionValue` keeps its formula (not aliased to EVSI); in evaluation sessions the planner's next scan comes from the EVSI table. |
| 6c UI + static artifact | done (green, 282 tests) | `src/views/EnsembleCompare.tsx` (new), `MonitorWorkspace.tsx` (renders it inside section 2 when `comparison.ensemble` exists; old markup otherwise), `monitor.css` (scoped `.mw-ens-*`; `.mw-detail > .mw-section { align-content:start }` so a taller section 2 does not stretch section 1's button), `src/state/localBridge.ts` (mounts the same workflow hub at `/api/workflow`, sim truth around scans), `src/state/workflow.ts` (LOCAL_BRIDGE routes every command through the in-page hub; actor "Demo operator"). Checked in the browser (vite `--mode artifact`): water scan → corroborated, evaluate → ensemble block; A-11 scan → disagrees, P(real) < 0.01. |
| 7 Validation | done | `scripts/validate/harness.ts` (`model: cascade \| ensemble`, `reality: legacy \| perturbed \| prior_predictive`, `widenedPriors`), `run.ts` flags, `engine/coverage.ts` updated with the results below. |

## Validation (36 scenarios × 50 iterations, perturb = default, seed 1)

| Model | Reality | p10–p90 coverage | p50 abs. error | bias | report |
| --- | --- | ---: | ---: | ---: | --- |
| legacy cascade | perturbed cascade (before; unchanged) | 24 % | 3.0 min | +0.9 min | `reports/validation-2026-11-08-default.md` |
| ensemble | prior-predictive (self-consistency) | 82 % | 3.0 min | +0.5 min | `…-default-ensemble-prior_predictive.md` |
| ensemble | perturbed ensemble (priors ±30 %, starts ±2 min, rates ±40 %) | 52 % | 4.9 min | +0.8 min | `…-default-ensemble-perturbed.md` |
| ensemble | perturbed legacy cascade | 46 % | 5.9 min | +4.3 min | `…-default-ensemble-legacy.md` |

The ensemble is calibrated against its own priors (82 %, target 80 ± 3 %) but misses the 75–85 % target when reality departs
from them (52 %), so the UI keeps "Model range, not a calibrated p10–p90". First rack right: 53 % → 81 % (perturbed) / 85 % (prior-predictive).

## Live Nemotron (nvidia/nemotron-3.5-lightning-30b-a3b), two evaluations

- heat (CH-1, P(real) 0.5): 16.0 s, 12 requests, 86k prompt tokens; Nemotron proposed 2 regions (set_p on chiller restart failure, generator FTS); validator warnings 0.
- water (PIPE-L2, P(real) 0.98): 18.4 s, 12 requests, 93k prompt tokens; 5 proposals rejected by the grammar (force on a continuous family, window 0–30) before 2 valid rounds. The digest and prompt now list families by type and ask for narrow tails.
- Local planner: 0.15–0.7 s per evaluation in Node (test bound 3 s).

## Live views switched to forecast mode (2026-11-08, audit C1 follow-up)

Supersedes the "opt-in" decision above for the live views: stage remote, `#/present`, Facility, Gauges,
the phone dashboard (`#/m`) and `/api/phone`. Out of scope and unchanged: MonitorWorkspace, workflow,
director, the scenario lab (`Simulation.tsx`), Dependencies, TwinDemo, random-scenario generation.

Design (in progress, notes kept as I go):
- WORLD = the store's `run` (script mode, unchanged): readings, water / fire / smoke footprints, steps,
  alerts and incidents, equipment that has failed by t (only shown once its root is observable).
- FORECAST = new `src/state/liveForecast.ts` `liveForecast(...)`: `simulateScenario({ mode: 'forecast' })`,
  memoised on the observation key (observed faults, inferable leak, started hazards from
  `forecastScenario`) + fixes + extra edges, so it reruns only when something new is observed.
  Exposed as `forecast` on the store context; used for every clock, countdown, next loss,
  "if nothing changes", the +N twin ghost, clock-based severity and fix savings (`mode: 'forecast'`).
- Measured in Node (scn-riser-leak): world run 84 ms; forecast run 4–7 ms with nothing observed,
  43–57 ms once the leak is inferable; `forecastScenario` (the per-tick key) 0.014 ms.
- Done and green at 01:07 (typecheck, 290 tests, lint 0 errors): `src/state/liveForecast.ts` (new),
  store `forecast`, `selectors.honestVisual(…, forecast)`, `usePrediction`, Present, Facility, Detail,
  Monitor strip, Inspector, FixPanel, StageRemote + remoteModel, MobileApp, `server/phoneSummary.ts`,
  `engine/fixes.ts` run cache keyed on the observation state in forecast mode (not on t),
  `tests/state/liveForecast.test.ts` (8 tests).
- 01:09:51: something outside this task wrote git merge conflict markers (HEAD vs origin/main) into
  app.css, AppShell, domain/workflow, state/workflow, FixPanel, Inspector, monitor.css,
  MonitorWorkspace, server/index, workflowHub, tests/workflow. My edits are on the HEAD side. I did not
  resolve them (not my merge); browser check waits on that.
- Playback measurement (Node, 1 min/s at the 5 Hz stage tick = 301 ticks over 60 min, no fixes):
  riser leak 3 engine runs (T+0, T+11 leak inferable, T+34 CRAH-2 observed), 141 ms in total, worst tick
  64 ms at T+11, cached tick 0.25 ms; OVH fire 2 runs / 25 ms; Azure chillers 3 runs / 22 ms; generator
  2 runs / 22 ms. `honestVisual` with the forecast 0.3–0.8 ms per tick (mostly the world's per-t visual).
- 01:12: the external merge finished (c008588, someone else's commit); my files came through intact.
  Re-run green: typecheck clean, 29 files / 290 tests, lint 0 errors.
- Browser check (isolated `vite --mode artifact` on :4182, temporary launch config since removed),
  riser leak, no console errors in fresh tabs:
  T+0 `#/present` "Ready" + "no observed fault · watching"; `#/stage` "No observed fault · watching." and
  the scripted-hypotheses list (CRAH-2 P ≈ 2.6e-6, PIPE-L2 P ≈ 8.7e-8, published rates);
  `#/app/facility` "If nothing changes: no observed fault · watching"; `#/m` "No running clocks yet";
  `#/app/gauges` A-11 "No loss from this alone". T+5 with +20 preview: "No observed fault · nothing to
  forecast yet", no ghost water. T+11/15: leak clocks, "Rack loss in 29–33 min", stage offers "Close the
  isolation valves · saves 48 racks"; after ordering it: "With your fixes 0 racks · 48 saved".
  In-browser `liveForecast` over 301 ticks: riser 3 runs, 118 ms total, worst tick 65 ms at T+11, median
  tick ≈ 0 ms; Azure 3 runs / 27 ms; OVH 2 runs / 14 ms; London 3 runs / 20 ms.
- Forecast fix savings once observed: OVH T+4 suppress fire saves 48 racks; generator T+3 manual start
  saves 48; Azure T+4 restart CH-1 saves 0 (CH-2's trip is only observed at T+8, so before then the
  forecast honestly sees one chiller still running).
- Not changed: `TopBar.tsx`, `controls.ts`, `mobile/derive.ts` (no prediction source in them; they read
  what callers pass). `src/domain/telemetry` is a stub that ignores `run`; if it starts predicting, it
  should take the store's `forecast`.
