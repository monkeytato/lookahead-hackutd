/**
 * Engine public API. UI code imports ONLY from here.
 * Pure, deterministic functions (seeded RNG) — no React, no DOM, no network.
 * The LLM never produces these numbers; it may only explain them.
 */
export { runCascade } from './cascade';
export type { CascadeOptions } from './cascade';
export { inletTempAt } from './thermal';
export { simulateWater, waterArrival, depthAt } from './water';
export { compareReadings, compareWithPosterior } from './verification';
export { evidencePosterior, DEFAULT_ERROR_MODEL, verdictFor, posteriorFrom } from './evidence';
export type { EvidencePosterior, EvidenceInput, ErrorModel } from './evidence';
export { freshness, severityFor, latestReadings, readingKey } from './readings';
export { rankIncidents, POLICY_VERSION } from './priority';
export type { PriorityContext } from './priority';
export { findRoute } from './routing';
export { transition, suggestAssignees, canComplete } from './tasks';
export type { TaskAction, TransitionResult, AssigneeSuggestion } from './tasks';
export { buildHandoff, handoffToMarkdown } from './handoff';
export type { HandoffNote, HandoffInput } from './handoff';
export { simulateScenario } from './simulate';
export type { ScenarioRun, ScenarioRunInput } from './simulate';
export { fixOptionsFor, fixOption, makeFix, predictFix, predictionSummary } from './fixes';
export { detectedAt, forecastScenario, observedFaults, scriptedHypotheses, leakInferableAt } from './observable';
export type { AssumedFault, FaultHypothesis } from './observable';
export type { FixOption, FixPrediction, FixContext, PredictionSummary } from './fixes';
export { hazardArrival, hazardFrameAt, hazardRadius } from './hazard';
export { leakSource } from './simulate';
export { runEnsemble, runEnsembleAsync, assetClocks, weightedQuantile, weightedMean, trialWeights, hashSeed, familiesFor, UTILITY_LAMBDA } from './ensemble';
export type { Ensemble, EnsembleInput, EnsembleOption, EnsembleHypothesis, OptionSummary, StressRegion, StressTerm, Mixture } from './ensemble';
export { zonesFor, zoneClocks, fansOffMinutes, fansOnMinutes } from './thermalZone';
export { PRIORS } from './priors';
