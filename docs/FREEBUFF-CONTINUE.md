## Latest visual refinement — continue from the implemented changes

User supplied the CenterGuard navy/teal shield logo and asked for matching colors, better top-bar spacing, and immediate visual feedback when requesting a simulation. Implemented palette: navy `#061a45`, logo teal `#009e90`, warm ivory `#faf7f2`, and a darker teal `#007e73` for accessible small-button text contrast. Brand.tsx is a crisp interface shield/wordmark; use the exact supplied PNG/SVG asset if available in your conversation, rather than claiming this vector recreation is the original raster.

The header now has an 80px desktop bar, 30px outer padding, deliberate group separation, and a clean second navigation row at narrower widths. Check the actual pane and phone widths for wrapping.

Operations simulation buttons now change immediately on click, show indeterminate progress beside the map, and persist completed/error feedback with explicit retry. They track the real request promise, not a fake progress percentage. Another client’s active evaluation is labelled separately. Scenario lab requests now have the same feedback, timeout and stale-request cancellation; changing inputs prevents old explanations from being attached to new parameters. The lab map uses the computed forecast run with clearly labelled Now/+15/+30/+60 views, separate from live monitoring.

Validate slow success, fast success, disconnected bridge, repeated click, input change during an explanation and keyboard/reduced-motion behavior. Leave the monitoring-first hierarchy intact. Do not publish or push. This session could not directly send this prompt to Freebuff or visually inspect its UI; use your normal local environment for the final visible check.

---

# Paste this into the existing Lookahead Freebuff project

Continue the implementation already present in this local project. Do NOT reset or re-clone: it contains the user's prior Freebuff changes and a new monitoring/SwiftUI implementation. Exact repository: https://github.com/monkeytato/lookahead-hackutd. Read `docs/PRODUCT-DEMO-REVIEW.md` and `ios/README.md` first.

User goal: an intuitive monitoring dashboard with portable independent verification, contextual Nemotron/engine response evaluation, clearly delegated tasks and a trustworthy timestamped record/handoff. Simulation is secondary. A native SwiftUI iPhone app should serve as a presenter/controller with **Simulate error**, visible warning delivery, real sensor collection and shared team response.

Already implemented:
- New primary MonitorWorkspace, shared domain workflow reducer and bridge `/api/workflow` GET/POST, persisted in the bridge store. Laptop and native controller share incidents, evidence, owners, checklists, analyses and history.
- Operations / Team response / History / Handoff navigation. Advanced sensor inventory, scenario lab and diagnostics are secondary. Existing source files were preserved.
- Four deliberately labelled warning injections; no physical actuator commands. Independent scan provenance, point, recency and quality validation. Fixture fallback clearly disclosed.
- Actual existing Nemotron director integration with honest local-planner fallback, recent action context, and conditional engine response comparison.
- SwiftUI app in `ios/LookaheadRemote.xcodeproj`, generated from `ios/project.yml`, device SDK build already verified unsigned.
- Compatible optional `vibrating` boolean in v1 sensor frames; no invented calibrated vibration value or firmware upload.

Complete this now:
1. Inspect git status and preserve all changes. Do not pull over the dirty working tree. Fetch only if needed; handle any newer upstream changes in an isolated worktree or by preserving the local work first. No destructive Git operations, push or public deploy.
2. Start/restart only this project's owned processes. Use `RACKMON_SIM=1 npm run dev:lan` for simulated verification; bridge stays loopback behind Vite LAN proxy. Do not touch the Arduino IDE or claim simulated frames are physical. Confirm `/api/workflow` works through the Vite URL.
3. Open `#/app` in Preview. Visually inspect desktop 1440×900, actual Freebuff pane width, and phone 390×844. Fix layout problems in the actual visible view, not just DOM geometry. Reduce anything still cluttered; do not add pills/dots/time strips. Check selected equipment, new-warning banner, direct scan/reference actions and user-visible failures.
4. Run `npm run build`, `npm test`, and the server workflow TypeScript check described in the review. Exercise warning → scan or labelled reference → owner → checklist → outcome → log → handoff. Confirm a second client sees the same state; reject forged/stale/wrong-location evidence and invalid ownership.
5. Build and install the REAL SwiftUI target onto the paired iPhone. Inspect Xcode's current account/team; the user previously chose clementwlake@gmail.com, but do not assume a numeric team ID. Use an existing appropriate team. Use `scripts/install-iphone.sh` with the actual TEAM_ID and DEVICE_ID, or Xcode Run. Do not change signing credentials, accept legal terms or switch accounts silently. If unlock, Local Network, trust or signing account interaction is needed, name the exact user step. Never claim installed if only built.
6. Connect both devices to the same trusted Wi-Fi. In the iPhone app's Connect screen enter the Mac's CURRENT private LAN Vite URL, not necessarily the old default. Test connection, trigger **Simulate error**, observe the warning on the laptop, and change a checklist on phone to see it on laptop. No public tunnels.
7. With the actual prototype, inspect its current serial output before choosing an adapter. Existing firmware expects v1 JSON. Do not overwrite the user's sketch or flash anything without a concrete wiring/protocol review. Verify temperature/water and qualitative vibration only for fields genuinely transmitted. Label acoustic estimates and missing/calibration channels honestly.
8. Rehearse the 3-minute story in the review. Keep the laptop on a clean monitoring overview. Keep demo controls collapsed. Leave new source uncommitted for review unless the user requests a commit. Report exact tested behavior, signing/install outcome, remaining blockers, and running URLs.

Pitch honesty: do not claim arbitrary outages are guaranteed prevented, every root cause proved, all facility telemetry live, or every missing detail found. Nemotron investigates and chooses tool runs; the engine computes model estimates and a person confirms real work. Handoff gap checks are rule-based.
