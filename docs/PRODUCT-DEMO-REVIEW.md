# LookaHead — product review and demonstration

## Product decision

LookaHead is a monitoring and coordinated-response workspace. The simulation engine is a decision tool inside an incident, not the product's homepage.

The existing Freebuff working tree was reviewed, including uncommitted edits to Operations, Simulation, Tasks, Rig, AppShell, the twin, fixture sensors and presentation. HEAD was `dbdf7d5`; existing edits were preserved. A pre-change source checkpoint is in `.runlogs/before-proposal-review.zip`. No synced reference files were changed. No Git push was performed.

The most important problem was structural: Operations displayed an invariant, normal sensor baseline while incidents and fixes lived in Simulation. The demonstration therefore taught users a simulator rather than showing how an operations team responds to uncertain evidence.

## What changed

| Keep and strengthen | Remove from the primary experience | Why |
|---|---|---|
| Facility map and equipment selection | Constant playback strip and running clocks | The first question is where the problem is, not how to drive a simulation. |
| Compact active issues with a visible next step | Dense scoring factors and repeated tags | Operators need a decision, with evidence available on demand. |
| Installed versus portable measurement comparison | Claims that independent sensors prove which device is faulty | Disagreement requires checking measurement point, timing and calibration. |
| Contextual Nemotron evaluation and engine comparison | A scenario catalog as the main workflow | Evaluate a response after identifying an issue. |
| Shared tasks, named owners, checklists and evidence | Multiple disconnected phone/task/session records in the main flow | Laptop and native controller must act on the same authoritative record. |
| Timestamped action history and handoff-gap checks | Automatic claims of exact root cause from nearby changes | Recorded sequence supports investigation; it does not establish causation. |
| Physical prototype readings with clear provenance | Pretending all facility values come from the one portable module | The prototype measures one selected location. |

The former sensor inventory remains at `#/app/inventory`, the scenario lab at `#/app/lab`, device diagnostics at `#/app/rig`, and dependency inspection at `#/app/dependencies`. Existing source and advanced functionality were retained rather than deleted. Main navigation is Operations, Team response, History and Handoff.

## Main screens

**Operations:** small current-status summary; active issues; facility map; selected incident. Each incident has four steps: verify, evaluate, assign/execute, record the outcome. A new warning from the controller appears as a prominent review banner. Normal equipment stays quiet and neutral.

**Team response:** one checklist per incident, qualified on-shift owner selection, measurement step completed only by evidence attachment, and clear equipment location. The map can show a route from the assigned person's last recorded demo check-in. This is not live staff tracking. Assignment and each checklist change are logged.

**History:** actual action-recording times, actor, source and incident. Search the record and add maintenance/investigation context without claiming causal certainty. Sensor evidence entries retain scan IDs.

**Handoff:** automatically derived missing-evidence, missing-owner and incomplete-checklist checks, decisions/outcomes, a recordable review and JSON export. Checks are rule-based. Nemotron evaluation receives recent event IDs as context; it is not a guarantee that every missing fact has been found.

**SwiftUI iPhone app:** Controller, Response and Sensor tabs. Controller has a single primary **Simulate error** action and four deliberate incident types. Response shows the same incident, collects a scan, assigns a technician, checks off actual work and records closure. Sensor shows current temperature, water and optional qualitative vibration capability. Connect accepts a private LAN address or `.local` hostname, never a public endpoint.

## A concise live walkthrough (~3 minutes)

| Beat | What to say | Laptop | iPhone / physical prototype |
|---|---|---|---|
| 0:00 | “When a warning could mean a failing sensor or failing equipment, uncertainty delays the response.” | Open Operations on a quiet, reset session. Explain that the hall is a demo; identify the separately labelled prototype source. | Show the actual module. Connection should say Connected to laptop. |
| 0:20 | “This is the operator's view. The phone lets us introduce a warning without changing real equipment.” | Keep the dashboard open. | Choose Temperature warning, tap **Simulate error**. A confirmation appears on the phone; a warning banner and highlighted equipment appear on the laptop. |
| 0:35 | “A hot installed reading alone does not tell us which measurement to trust.” | Review warning, show A-11 and installed 34.2 °C labelled demo. | Put the module at the corresponding demonstrator point. Collect its 10-second scan from Response. Do not call a simulator result live. |
| 0:55 | “The independent reading disagrees. We investigate the sensor rather than shutting down equipment blindly.” | Show source, value, verdict and quality note side by side. Disagreement is evidence, not proof of a broken sensor. | If compatible hardware is unavailable, deliberately use the disclosed **labelled demo reference** and say so. |
| 1:15 | “Every issue needs an owner and a clear next step.” | Select Marcus, show the named checklist and route from a recorded check-in. | Tick equipment confirmation, inspection performed and recheck only after performing them on the demonstrator. Verification is evidence-driven, not a free checkbox. Record the inspection result to close the alert. |
| 1:40 | “When the problem is real, we need to understand what it can affect next.” | Leave the dashboard visible. | Trigger Water leak. Wet the prototype's sensing pad in the demonstrator and take the floor/leak scan, or use a disclosed fixture reference. |
| 2:00 | “Nemotron investigates the evidence and uses the dependency engine to evaluate downstream risk.” | Select **Evaluate with Nemotron** if configured. Otherwise explicitly say local planner. Show a conditional engine comparison of response/no response; do not read model rack counts as measured losses. | Keep the controller on the shared Response record. No actuator command is sent by this controller. |
| 2:25 | “Now the team knows where to go, what to check, and what has already been done.” | Show Team response. Assign a suitable technician; show work continuing on the phone. | Demonstrate one checklist update and its appearance on the laptop. |
| 2:45 | “The next shift inherits the evidence and the decision, not an incomplete story.” | Open History, then Handoff. Show a deliberately missing owner/checklist step being flagged, or export a complete record. | Tap Review handoff gaps to record the review on the laptop. |

Shorter fallback: one temperature warning, one physical scan, one owner, one logged outcome, one handoff. Skip the second warning if the presentation is running long.

## Claims and source correction

The supplied Uptime link refers to older research and does not support the exact figures cited. Uptime Institute's **May 13, 2026 Annual Outage Analysis announcement**, reporting its 2025 survey, states 57% of respondents' most recent major outages cost more than $100,000 and one in five exceeded $1 million:
https://uptimeinstitute.com/about-ui/press-releases/uptime-announces-annual-outage-analysis-report-2026

Use: “Uptime Institute reports that 57% of respondents' most recent major outages cost over $100,000, and one in five cost over $1 million.”

Prefer these product claims:
- “Helps teams identify developing incidents and evaluate responses before damage spreads,” rather than “solves problems before they occur.”
- “Cross-checks independent readings to distinguish likely equipment issues from measurement disagreement,” rather than “eliminates faulty internal sensors as a possibility.”
- “Records changes and evidence to support investigation and avoid repeating mistakes,” rather than “traces every failure to an exact change.”
- “Flags gaps in ownership, evidence and procedure for handoff,” rather than “ensures no information is left out.”

## Data and implementation boundaries

The installed facility readings and injected warnings are demonstration fixtures. The physical sensor stream is real only when the bridge stamps frames `source: live`. A simulated module and a scripted reference retain different labels. Nothing in the new controller changes physical actuators.

A scan must be complete, recent, taken after the warning, match the equipment and measurement point, contain sufficient samples, and pass relevant quality checks. Bad quality returns inconclusive. The module does not become a sensor for every rack.

The existing v1 firmware protocol includes acoustic temperature, an optional reference temperature, raw water sensors and quality flags. Added backward-compatible optional JSON field `vibrating: true|false|null` supports a digital vibration detector. It measures detection frequency, not calibrated mm/s. No firmware was flashed or Arduino serial monitor taken over. If the actual sketch outputs human-readable Serial text instead of v1 JSON, an explicit adapter is still required. See `ios/README.md`.

Shared workflow state lives on the bridge at `/api/workflow`, persisted with its store; both web and native app poll that state. Legacy stage/engine records remain separate in the scenario lab. The static artifact fallback has browser-local demo state only and cannot pair a native phone across devices. The LAN bridge is a trusted-demo service, not a production authenticated facility system.

## Validation and current limits

Web production build and TypeScript checks pass. Full existing suite plus workflow tests: 210 passing at the last full run. The stale reading test was narrowed to the temperature metric because existing Freebuff edits had added humidity for the same asset. Native SwiftUI app builds for the iPhone device SDK with signing disabled.

This session cannot control Freebuff, open a browser for visual QA, bind a local server port (`EPERM`), discover an iPhone through CoreDevice (service timeout), or access a valid signing identity. Therefore no live desktop/phone round trip, signed install, visual QA or on-device launch is claimed. Source, Xcode project, install script and continuation prompt are ready for Freebuff's normal local environment.
