# Changelog

All changes to CenterGuard, formerly Lookahead (HackUTD 2026, Northmark Compute & Cloud track), newest first.
Repo: `monkeytato/lookahead-hackutd` · branch `main`.

## 2026-11-08 · Handoff follow-ups and a tighter landing page

- Removed the landing hero eyebrow "Data center operations" and the full "Incident example / Two warnings at once" comparison section.
- The "Collect independent sensor evidence" step now fills itself with the attached reading (for example, "22.5 °C attached") and stays checked once any measurement exists. Inconclusive evidence remains a visible handoff gap for a repeat measurement.
- Handoff now lets the operator resolve an incident by carrying every open checklist step into a follow-up task, or by deleting the incident (and any linked task) after an in-page confirmation.
- Follow-up tasks appear on Team response with their remaining actions, and open task steps appear in the handoff gap review.

## 2026-11-08 · The demo reference now counts as verified

- "Collect independent sensor evidence" now ticks itself with **any conclusive evidence**: a live or simulated scan, or the labelled demo reference ("Attach labelled demo reference"). Team decision, so a walkthrough without hardware closes cleanly instead of being flagged red.
- It stays unchecked, and the close is flagged, with no evidence or with an inconclusive scan. The hint for the demo reference case is gone.
- The demo reference is still labelled as a scripted fixture in History, the handoff and its evidence note; it is not presented as a measurement. `hasIndependentEvidence` is unchanged; the new `hasConclusiveEvidence` drives the step.
- The iOS controller already showed the step as done from its stored flag, so it now agrees with the laptop.
- ✓ 309 tests passing · typecheck clean · artifact rebuilt.

## 2026-11-08 · Landing page: Evidence section with every prediction chart

- New **Evidence** section on the landing page (nav link "Evidence", between "Why the clock matters" and the final button). It opens with four numbers: 2,048 physics trials per response option, 0 numbers written by Nemotron, under 1 °C error on an independent published restart, and 82 % / 52 % p10–p90 coverage against the model's own and widened priors (target 80 %).
- All 8 charts from the Prediction Science brief follow, each with a one-line takeaway and the brief's full caption: real failure or bad sensor (Fig. 3), minutes to each limit (Fig. 2), how one forecast is made (Fig. 1), the WP179 backtest (Fig. 6), the CFD consistency check (Fig. 7), INL failure odds (Fig. 4), Dallas–Fort Worth heat (Fig. 5) and interval coverage (Fig. 8).
- The charts are not redrawn. `scripts/extract-evidence-figures.mjs` copies them from `docs/pdf-src/CenterGuard-Prediction-Science.html` into `src/landing/evidenceFigures.ts`; rerun it after `node docs/pdf-src/build.mjs`.
- The section states the misses and limits plainly: the 12-minute case was the tuned one, the 4-minute restart is over-predicted, Fig. 7 is a consistency check only, and coverage is measured against simulated outcomes.

✓ typecheck clean · checked in the dev server at desktop and 375 px (8 charts, no sideways scroll) · artifact rebuilt.

## 2026-11-08 · Response simulation plays on the 3D map; verify step follows the evidence

**The evaluation plays on the 3D map**
- After "Simulate response", the incident replays on the Facility map from "now" to the end of the horizon. Water spreads, failed equipment shows LOST, and the fix shows its recovery when it takes effect. It auto-plays once, without a response first.
- The bar over the map has play/pause, a **Without / With fix** switch, a scrubber with a marker where the fix lands, the clock (+N min) and **racks down**. Water leak, for example: without a response, UPS-A and all 48 racks are lost at +32 min. With the valves closed at +4 min, the B-side power still fails, but 0 racks go down.
- The replay is one deterministic run of the incident's own scenario (`src/domain/scenarios/playback.ts`). The alarm's effect is included only when P(real) ≥ 0.5, and low-prior hypotheses are left out. The ensemble stays the source of the probabilities.

**Fewer words in "2. Evaluate a response"**
- Two numbers: the chance of service impact in the next N min, without and with the fix (from 100 weighted quantile futures, `futures` in `summarizeOption`, never sent to Nemotron). Then **▶ Watch on map**, and "Measure next" when a scan would help.
- Everything else moved under one **Details** fold: the director's summary, figures, basis, P(real), stress regions and hypotheses. Analyses stored before this change keep their old figures.

**Verify step (the auto-flag)**
- `stepDone` now ticks "Collect independent sensor evidence" exactly while a conclusive live or simulated scan is attached, so a stored flag can no longer leave it stuck unchecked after a valid scan. An inconclusive scan does not count. (A demo reference did not count at first; see the entry above.)
- The hint next to it now says why: "demo reference does not count, take a scan" or "inconclusive, repeat the measurement".
- A scan that arrived while another command was in flight was silently never attached. It is now retried.
- Still by design: a chiller (heat) incident's verify step can never pass, because the rig cannot measure chilled water.

✓ 307 of 308 tests passing; the one failure is the known load-flaky `audit.test.ts` "random draws", which passes alone · typecheck clean · artifact rebuilt. Checked in the artifact build: water leak, without 51 % / with 13 %; the replay ends at 48 vs 0 racks down.

## 2026-11-08 · Final cleanup, team responses, flagging fixes, online deploy

- **Front pages:**
  - Landing: the hero line is now "Data center operations" (no "· prototype"). Removed the small print: the "Presenting?" links row, the "Illustration" labels and captions, the A-10/A-12 footnote, the sensor-connection note, the "All facility data…" line under the final button, and the footer.
  - Facility overview: removed the "Simulated prototype" status tile, the "Portable sensor" panel and the small grey helper and disclaimer lines. The checklist-flag hints are kept.
- **Scanner removed:** the `#/scan` page (`src/scan/`) and every link to it are gone: top bar, More menu, Rack node, director panel and phone dashboard. Portable scans still run from the Facility overview's "Take portable sensor scan" button.
- **Submission flagging:**
  - A close verified only by the scripted demo reference now counts the "Collect independent sensor evidence" step as unchecked. Before, it was recorded as a clean close.
  - Checklist ticks and the handoff gap list now use the same rule (`stepDone` / `uncheckedSteps`), so the flag, the checkbox and the handoff always agree.
  - New tests cover the server hub and the in-page bridge flagging identically.
- **Create a team response:** Team response now has a "Create a team response" card where you enter a title, choose equipment and choose a type. It adds the new `create_response` command, which uses the default 4-step checklist, so the response then runs through assign, verify, submit and flag like any other. The scripted demo reference is offered only on demo equipment.
- **Nemotron and online hosting:**
  - The artifact can never run Nemotron, because it has no server and the key never ships to the browser.
  - The bridge now serves the built app in production (`npm start`, `$PORT`, `0.0.0.0`), loads `serialport` lazily and reads `.env.local` from the project root.
  - New `render.yaml` Blueprint, with `NVIDIA_API_KEY` as a dashboard secret and the eval budget set to 45 s, plus a `Dockerfile`. Deploy steps are in the README.
  - Verified live: the key and the model respond, and evaluations return `provider: nemotron` in 16–30 s.
- ✓ 303 tests passing · typecheck clean · lint 0 errors · artifact rebuilt.

## 2026-11-08 · The product is named CenterGuard

- Every user-facing name is now CenterGuard:
  - the brand in the top bar, phone, scanner and stage remote;
  - the artifact page title;
  - the default operator name in the log;
  - the director's ticket footer, ticket label (`centerguard`) and weather User-Agent;
  - the iOS display names ("CenterGuard"; the dial companion is "CenterGuard Dials") and the local-network prompts;
  - README, CONTRIBUTING, this changelog's header, and the PDF cover.
- Internal identifiers keep the old name, so nothing breaks: localStorage keys (`lookahead.*`), the BroadcastChannel name, the npm package name, the Xcode targets and schemes, the bundle IDs, the launch-config names, the repo `monkeytato/lookahead-hackutd`, and the `lookahead/` folder. The lowercase "lookahead" in the code (`lookaheadMin`, prediction minutes) is the ordinary word, not the brand.
- Dated records stay as written: the audit, the product demo review, earlier changelog entries and `server/.data/store.json` history.
- ✓ 290 tests passing · typecheck clean · lint 0 errors · artifact rebuilt.

## 2026-11-08 · in `e68dfe3`: live views forecast from what has been observed

- The stage remote, `#/present`, Facility, Gauges, the phone `#/m` and `/api/phone` (iOS) now take every prediction from a no-foreknowledge forecast (`src/state/liveForecast.ts`). That covers clocks, next loss, racks at risk, "if nothing changes", the +N ghost and fix savings. The script run still drives what actually happens: readings, water, fire, steps and auto-pause.
- At T+0 of the riser leak every view shows "No observed fault · watching", not "Next loss: riser in 4 min · 48/48". Leak clocks appear from T+11, when the make-up flow mismatch is observed.
- The forecast is memoised on the observation state, so a 60-minute riser playback costs 3 engine runs (about 120 ms in total). The `fixes.ts` forecast cache uses the same key.
- The stage remote has a presenter-only list of scripted faults that can't be observed yet, with their published priors.
- **Demo note:** on the Azure replay, restarting CH-1 at T+4 forecasts no saving. CH-2's trip is only observed at T+8.
- ✓ 290 tests passing · typecheck clean · lint 0 errors · artifact rebuilt.

## 2026-11-08 · `e68dfe3` + `c008588`: incomplete submissions, science-based predictions, audit

Committed and pushed by Alex as `e68dfe3`, then merged with origin/main in `c008588`.

**Incomplete report submission**
- An outcome can now be submitted with checklist boxes unchecked. It still needs an owner and a note of at least 8 characters, and the operator confirms first.
- Unchecked steps are saved on the issue (`incomplete`), and the resolution event is flagged `incomplete`. A missing or inconclusive measurement counts as an unchecked verify step.
- History and Handoff rows for these submissions are highlighted red, and both pages list "Incomplete submissions". Team response cards are flagged.
- `reviewWork` reports these issues as handoff gaps.

**Predictions** (spec: `docs/PREDICTION-SCIENCE.md`; build log: `docs/PREDICTION-IMPLEMENTATION-NOTES.md`)
- **No-foreknowledge forecasting** (`engine/observable.ts`): future scripted faults become hypotheses with published-rate priors. The director and evaluate always forecast. The stage, present, Facility and phone views still replay the script.
- **Physics thermal zones** (`thermalZone.ts`):
  - Energy balance across room air, IT mass and chilled water, with a calibrated coupling factor.
  - Two clocks: 32 °C (out of the ASHRAE allowable envelope) and 40–45 °C (service impact).
  - Backtested against Schneider WP179 and published CFD points.
- **Two-level Monte Carlo** (`ensemble.ts`): parameter uncertainty is drawn on the outer level, with shared zone draws. Uses INL reliability priors (`priors.ts`). 2,048 trials per option.
- **Evidence posterior** (`evidence.ts`): installed reading vs portable reading, scored with a Student-t error budget to give P(real). It refuses quantities the probe can't measure. `verify_scan` uses it.
- **Evaluate fix:** each warning kind runs in its own `incident-*` scenario, and the evidence moves the result. The chiller case was 48 racks and is now 0 with no response. A second chiller trip is a hypothesis.
- **Nemotron red team** (`stress.ts`, `server/director/evaluation.ts`):
  - Nemotron proposes up to 6 stress regions in a closed grammar.
  - The engine samples a defensive mixture (α = 0.3) with capped weights, so the estimate stays unbiased whatever Nemotron proposes.
  - EVSI next-scan ranking (`evsi.ts`).
  - `validate.ts` also checks percentages, counts, "1 in N" and signed-shift direction. Log context goes to the director as a structured field.
- **UI:** `EnsembleCompare` in section 2 shows P(real), the two clocks labelled "model range", trials, stress regions and the next scan.
- **Coverage:** 24% → 82% against the model's own priors, but only 52% with priors widened ±30%. The UI therefore keeps "model range, not a calibrated p10–p90".
- **Data:** about 30 MB pulled into `research/` (10 years of DFW hourly weather, NOAA ISD, INL reliability, ASHRAE, WP179, Binghamton). `research/SOURCES.md` lists every source.

**Docs**
- `docs/AUDIT-2026-11-07.md`: full site audit with 45 findings.
- `docs/CenterGuard-Prediction-Science.pdf`: how the predictions work.

✓ 282 tests passing · typecheck clean · lint 0 errors · artifact rebuilt.

## 2026-11-07 · Local merge, not committed: Clement's rework + the gauge monitor

This is in the working tree only. Nothing has been committed or pushed yet.

- **Clement's `50744a7` is merged into the local work.** His shell and home screen (`MonitorWorkspace`) stay the default. His sensor inventory stays at `#/app/inventory`, and his simulation lab at `#/app/sim`.
- **Two new tabs carry the local work:** **Gauges** (`#/app/gauges`: dials, trends, a "What's wrong" strip, and Fix) and **Facility** (`#/app/facility`: the fix queue plus the 3D hall, now `src/views/Facility.tsx`). On both tabs the simulation bar (`TopBar`, in its new `embedded` mode) sits under the header, with Play, Spawn disaster, Back to normal and the ⋯ menu.
- **Both versions of `Operations.tsx` stay, as separate files:** Clement's sensor inventory is `Operations`, and the local 3D workspace is `Facility`.
- **CSS:** Clement's `app.css` also uses `.mon*`, so the gauge page's classes are now `gm-*` in `src/views/gauges.css`. Clement's `monitor.css` is unchanged.
- **FixPanel:** keeps the local one-line option layout, with Clement's wording ("Apply fix", Pending/Applied, "needs ~N min") and his record of what an applied fix saved.
- **Inspector:** supports both `brief` (local) and `hideFix` (Clement).
- **server:** keeps both `/api/phone` (local) and `/api/workflow` (Clement).
- **iOS:** there are now two separate apps. LookaheadRemote (Clement) builds from `ios/project.yml`. Lookahead, the dial companion, builds from `ios/Lookahead.yml`, run as `xcodegen --spec Lookahead.yml`. The README covers both.
- `ControlBar.tsx`, `PredictionPanel.tsx` and `Timeline.tsx` stay deleted. Clement's version no longer used them either.
- ✓ 229 tests passing · typecheck clean · artifact rebuilt.

## 2026-11-07 · `50744a7` (Clement) · Rework the demo around monitoring, sensor coverage and shared response

- **A monitoring dashboard** replaces the busy operations view. Every asset has a normal sensor baseline, and there is a clickable sensor key (`src/domain/sensors.ts`).
- **A shared response workflow** (`src/domain/workflow.ts`, `server/workflowHub.ts`, `GET/POST /api/workflow`): simulate a warning, verify it with a 10 s scan, assign a technician, run the checklist, resolve, and review the handoff.
- **Simulation lab** (`#/app/sim`), plus CenterGuard branding (`Brand`, `brand.css`).
- **Native iPhone controller** `ios/LookaheadRemote` (SwiftUI).
- Rig protocol: an optional `vibrating` field.

## 2026-11-07 · Live presentation: phone remote, random and real disasters, fixes, a growing 3D twin

**Present from two devices**
- `#/present` is a full-screen presenter view: headline and source, a large clock, top clocks, forecast, event ticker, prediction banner and fix toasts.
- `#/stage` is a phone remote: random disaster, real incidents, play/pause/±5/speed, prediction +10/+20/+30, fixes with predicted savings, and camera focus.
- Every screen follows one shared **stage**: scenario, clock, speed, fixes, prediction and focus (`src/stage/`). It travels over the laptop bridge (`POST /api/stage` + SSE, `server/stageHub.ts`), the claude.ai `room` + `db` capabilities in the artifact, or same-browser tabs as a fallback.
- **Pacing for a live demo:** 1× is now 1 scenario minute per second, so a 60-minute disaster runs about a minute. **Pause on each new incident** is on by default, so every screen stops when an alarm fires. That leaves time to explain and order a fix.
- Plain links `#stage`, `#present`, `#phone` and `#app` work, so an artifact link can open the remote directly.

**Disasters and prediction** (`src/domain/scenarios/`)
- **Random disaster** (`rnd-<seed>`, deterministic per id). The templates are a leak, chiller trips, a CRAH failure, utility loss with generator no-start, a UPS fire, and PDU breaker trips. Half the draws add a compounding second event, and every draw yields at least one clock.
- **Real incidents, adapted and compressed:**
  - Google Cloud Paris 2023 water leak
  - NaviSite generator no-start
  - London heatwave cooling failures, July 2022
  - OVHcloud SBG2 UPS-room fire, March 2021
  - Azure Australia East chiller trips, August 2023

  Each scenario names its public source.
- **Fire and smoke** are a new hazard layer: footprints spread in rated zones, and assets inside them fail.
- **Prediction:** "if nothing changes" forecasts, and a prediction ghost at +N minutes.

**Fixes** (`src/domain/engine/fixes.ts`)
- **Options per asset:** close an isolation valve, restart a chiller, reset or cover a CRAH, start the generator manually, transfer a UPS, release fire suppression, reset a breaker, shed load, or bring in portable cooling. Each has a stated delay assumption.
- The engine repairs the asset from the time the fix takes effect. Losses that already happened stay, and downstream loss only spreads if the source is still down. Water stops at an isolated source, and suppressed fire is contained.
- Every option shows a counterfactual, e.g. "saves 48 racks". Example: isolating the Paris riser at T+12 cuts losses from 67 assets to 7, and from 48 racks to 0.

**3D twin that grows and changes** (`src/twin/`)
- **Build-in:** the facility assembles itself on load and on every new scenario.
- Time glides smoothly, so water, fire, smoke and heat visibly grow.
- **State changes:** ripples mark new failures, lost equipment goes dark and sinks, and fixed equipment gets a recovery sweep. Racks pulse faster as their clock runs down.
- The prediction ghost shows dashed future water, fire and losses.
- Only the 5 most urgent labels are shown, and the camera follows focus. Presenter mode adds an idle orbit and swings to new critical events.
- About 78 fps.

**A clearer workspace**
- A control bar holds the scenario picker, Random disaster, play/±5/speed, a scrubber with event and fix ticks, Prediction, the Phone remote link and a link status.
- "Fix this" in the Inspector and on queue cards. A prediction panel with/without your fixes.
- **Plain wording:** "T−15 min" instead of "(15–15)", and "Certain within the hour" instead of "100% of runs". Rank formulas sit behind "Why this rank".
- Fixed a crash on random/real ids in Dependencies. `confirm()`/`alert()` are replaced with in-page confirms, since artifacts block dialogs.

**Tests:** 202 passing (was 167), with new engine fix/hazard, scenario and stage protocol tests.

## 2026-11-07 · `75ef142` · Static demo build, published as a claude.ai artifact

- **`npm run build:artifact`** builds `dist-artifact/`, a version of the whole site (landing, workspace, 3D twin, scanner, phone dashboard) that runs with no server.
- **In-page bridge** (`src/state/localBridge.ts`): the same API and events as `server/index.ts`, built from the same modules. That covers the simulated rig at 1 Hz with a one-minute warm-up, rig rules, hold-to-scan statistics, scan requests, rig commands, and the agent hub with the deterministic local planner. Scans, requests, events and approvals persist in that browser's localStorage.
- **Honest limits:** no NVIDIA key ships in the page, so the director says "local planner (no key)". Weather and GitHub tools report "not reachable from the static demo".
- `src/state/bridge.tsx` routes the event stream and `api()` to the in-page bridge only when built with `--mode artifact`. `npm run dev` is unchanged.
- **Small portability fixes:** `server/agentHub.ts` uses global `crypto.randomUUID`, the director reads `process.env` only when it exists, and `BroadcastChannel` is guarded for sandboxed frames.
- `scripts/artifact-page.mjs` writes `artifact.html` and a `files.json` manifest for republishing to the same artifact URL. `npm run preview:artifact` serves the build on port 4174.
- **Verified** on the static build with no server running: workspace and twin render with no console errors and no `/api` requests. The rig streams, a director plan runs, and a full 10 s scan completes (10 frames).

## 2026-11-07 18:15 · `8b29aa5` · Phone dashboard and live Nemotron director

**Phone dashboard, `#/m`** (new: `src/mobile/`)
- A supervisor view built for a phone. It complements the desktop workspace (`#/app`) and the scanner (`#/scan`).
- **Header:** site, scenario clock, SIMULATED tag, rig link status (live / sim / offline) and director status (Nemotron / local planner / offline).
- **Now tab:** up to four impact clocks (p50 with the p10–p90 range, or LOST) and the ranked response queue. Tap an incident for its summary, priority factors and owner, with links to the technician view and to the scanner when a scan is open.
- **Rig tab:** live Rack Monitor tiles (inlet top/bottom, outlet, reference, floor probe, rack power), ΔT, actuator states, and a chart of the acoustic beams against the reference probe. Also open scan requests and rig events.
- **Director tab:** the latest plan with next scan, follow-up action and tool steps; a Run button; Approve/Reject for pending actions. It uses the same endpoints as the desktop panel.
- **Team tab:** task counts, tasks sorted blocked-first with links to the technician view, and people on shift with stale check-ins flagged.
- **Bottom:** play/pause for the scenario clock and a 4-tab bar with badges.
- **Style:** IBM Carbon and ISA-101, grayscale until something is abnormal. Light and dark modes, safe-area insets, 44 px touch targets, and no horizontal scroll at 360–430 px.
- A "Phone ↗" link in the desktop top bar and a row in the README routes table.

**Nemotron director, now live**
- The NVIDIA key lives in the git-ignored `.env.local`. It is never committed.
- **Fix:** hosted models made one tool call per turn and ran out of turns before calling `recommend`, so every run fell back to the local planner. The director now gets 12 turns (was 8). With two turns left it is told to wrap up, and on the last turn `tool_choice` forces `recommend`. If a host rejects a forced tool_choice, the turn retries with `auto`.
- **Default model** is now `nvidia/nemotron-3.5-lightning-30b-a3b`, verified live (about 13–25 s per full run, no validator warnings). For this key, `nemotron-3-super-120b-a12b` returned 404. `nemotron-3-ultra-550b-a55b` works but often exceeds the 15 s per-request timeout. `nemotron-3-nano-30b-a3b`, `llama-3.3-nemotron-super-49b-v1.5` and `nvidia-nemotron-nano-9b-v2` are end-of-life (410).
- `.env.example` lists every model id that was checked. The README now says the director was run live.

**Tests:** 167 passing (was 149). New: `tests/mobile/derive.test.ts` (16) and two director tests for the wrap-up nudge, the forced `recommend` and the tool_choice retry.

## 2026-11-07 17:58 · `d81f93c` · Director: external tools, approval gate, automatic re-plan

- New agent tools:
  - `get_weather`: api.weather.gov.
  - `get_rig_status`: Rack Monitor.
  - `request_scan`: scanner queue.
  - `propose_rig_action` and `open_ticket`: the approval queue, then the rig or GitHub Issues. Only safe-direction rig commands are allowed.
- **Agent hub on the bridge:** when a scan the director queued comes back, the result is applied to the director's snapshot and it re-plans by itself (up to 3 automatic re-plans per chain).
- **Approvals:** hardware commands and tickets run only after a person approves them on the dashboard, and every decision is logged.
- The local planner uses the same external tools, so the no-key path shows the full workflow.
- **Dashboard:** plan generations with a what-changed diff, steps tagged by service, an approval queue, and automatic re-plans recorded in the shared log.
- 11 new tests: weather, the safety whitelist, queueing, re-plan and approvals.

## 2026-11-07 17:36 · `0a8e1ff` · Rack Monitor link, hold-to-scan app, Nemotron simulation director

- **Rig protocol v1:** USB serial JSON at 1 Hz, shared by the firmware, bridge and simulator.
- **Bridge server:** serial autodetect and hot-plug, a simulated rig fallback, an SSE stream, scans computed on the server, scan requests, rig commands and rig rules.
- **Scanner app (`#/scan`):** live channel values with sparklines. Hold to scan for 10 s (5 s minimum, one full acoustic beam cycle); results show mean ± sd and n.
- **Dashboard:**
  - Scans become reference evidence and verification verdicts.
  - A scan can be requested from an incident.
  - New Rack node page: acoustic vs reference, rig events, failure staging.
- **Nemotron simulation director:** a tool-calling agent that runs what-if engine simulations, ranks scans by decision value and cites run ids. A validator strips unsupported numbers, and a deterministic local planner is the fallback.
- Rig scan statistics, root-cause rules for ten situations, and a simulated rig, all with tests.
- Arduino UNO R4 firmware per the wiring doc (not yet compiled or flashed).

## 2026-11-07 16:57 · `6c518db` · Docs: note how to enable CI

- The gh token lacks the `workflow` scope, so the CI config lives in `docs/ci-workflow.yml` with steps to enable it.

## 2026-11-07 16:57 · `82d6363` · Lookahead prototype: ops dashboard, 3D twin, cascade engine, landing

- Shared domain contracts and the simulated facility DAL-1 / Hall A, with 3 scenarios.
- **Pure engine:** Monte Carlo cascade clocks, lumped thermal model, water height-field, verification verdicts, priority policy, constrained routing, task state machine and handoff builder (40 vitest specs).
- **Operations workspace:**
  - Clock strip and ranked queue.
  - 3D twin (React Three Fiber) with water, heat, dependency and people layers, plus a look-ahead preview.
  - Inspector with the Why chain, evidence, assignment and routes.
- Technician phone view, tasks board, team check-ins, dependency review with replay, append-only log, and shift handoff export.
- Carbon + ISA-101 styling, landing page, contributor docs, and CI config (in `docs/`).

## Known open items

- The Arduino firmware is not compiled or flashed. Everything is tested against the simulated rig.
- No accelerometer on this build, so CRAH-2 vibration stays a runbook check.
- One approval is still waiting in the bridge queue from an earlier run. It was left untouched on purpose.
- The phone dashboard and desktop share one scenario clock, so play/pause on one moves the other.
- The main JS bundle is about 1.5 MB (Vite warns). The phone page is code-split.
- The NVIDIA key was shared in chat. Rotate it on build.nvidia.com after the hackathon.
