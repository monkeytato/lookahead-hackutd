# Changelog

All changes to Lookahead (HackUTD 2026, Northmark Compute & Cloud track), newest first.
Repo: `monkeytato/lookahead-hackutd` · branch `main`.

## 2026-11-07 · Static demo build, published as a claude.ai artifact

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
