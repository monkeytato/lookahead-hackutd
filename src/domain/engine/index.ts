/**
 * Engine public API. UI code imports ONLY from here.
 * Pure, deterministic functions (seeded RNG) — no React, no DOM, no network.
 * The LLM never produces these numbers; it may only explain them.
 */
export { runCascade } from './cascade';
export type { CascadeOptions } from './cascade';
export { inletTempAt } from './thermal';
export { simulateWater, waterArrival, depthAt } from './water';
export { compareReadings } from './verification';
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
