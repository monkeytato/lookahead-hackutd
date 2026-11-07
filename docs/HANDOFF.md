# Data Center Operations Platform — Full Project Handoff

**Document version:** 1.0  
**Prepared:** November 7, 2026 (America/Chicago)  
**Purpose:** Product, design, hardware, engineering, and demo handoff for the next build.  
**Working name:** Unassigned. The existing prototype directory is named `Relay`; retain that directory until a deliberate rename. A 2025 data-center submission already used Relay, so do not present the name as unique.  
**Build status:** An earlier software prototype exists. The expanded hardware-verification, employee-location, dispatch, routing, landing-page, and task-completion scope below is a specification, not a claim that those features already work.  
**Sensor connection:** Deliberately left blank in Section 15. Do not choose or implement a sensor transport, pairing process, ingestion endpoint, or phone relay from this document.

## 1. Challenge and product purpose

> Data center teams run around the clock, and a missed warning, an unclear handoff, or wrong information at the wrong time can turn a small issue into a major outage. Build a solution that helps those teams stay one step ahead.

Build a data-center operations platform that helps teams verify warnings, understand cascading consequences, prioritize competing problems, assign the right employee, lead that person to the correct equipment, complete work with evidence, and preserve context for the next shift.

The product addresses two complementary situations:

1. **Before a failure:** identify developing issues, notice contradictory or stale information, and request a useful verification before the issue escalates.
2. **During an incident:** minimize disruption by deciding which investigation or repair to perform first, accounting for dependencies, available staff, travel, repair constraints, and uncertainty.

The operating loop is **detect → verify → assess → prioritize → assign → navigate → complete → hand off**. The map, AI, portable hardware, and task log must support that same loop rather than becoming disconnected features.

### One-sentence explanation

A data-center operations platform that combines independent physical verification, AI-assisted investigation, impact simulation, employee dispatch, and evidence-backed task handoffs to help teams act on the right problem first.

### Pitch paragraph

When several data-center alarms fire at once, teams need to know which warnings to trust and what to fix first. Our platform combines an interactive facility map, equipment telemetry, and a portable external sensor module that measures temperature, humidity, vibration, and liquid presence to independently cross-check reported conditions and flag possible sensor faults or equipment problems. NVIDIA Nemotron analyzes those readings alongside technical logs, maintenance records, and equipment dependencies to investigate causes, uncover overlooked connections, and recommend the next verification or repair task. A deterministic simulation engine estimates cascading failures and compares proposed responses, helping teams prioritize incidents by service impact, urgency, available resources, and uncertainty. Supervisors assign work to suitable employees, who use a phone-friendly interface to find the correct equipment, follow checklists, capture evidence, and report completion. A shared, timestamped log preserves readings, notes, decisions, assignments, and unresolved risks so every shift understands what happened and what needs attention next.

The paragraph describes the intended product. The connection between hardware and software remains undecided; do not add a connection claim to the pitch until implemented and tested.

## 2. Decisions, recommendations, and open questions

| Item | State | Direction |
| --- | --- | --- |
| Data-center monitoring and incident response | User-defined | Main product |
| Prevention plus incident damage reduction | User-defined | Support both through one operating loop |
| Portable external hardware | User-defined | Independent physical cross-check; no equipment modification required for the intended measurements |
| Temperature, vibration, moisture | User-defined | Core measurement categories |
| Air humidity versus liquid presence | Clarification | Treat them as separate measurements; neither substitutes for the other |
| Cohesive facility map and shared log | User-defined | Central working surfaces |
| AI investigation and repair prioritization | User-defined | Nemotron reasons over evidence and engine outputs |
| Organization, employees, task delegation/completion, navigation | User-defined in latest instruction | Required expanded product scope |
| Landing page | User-defined in latest instruction | Required description and design plan; separate from the operations workspace |
| Sensor connection | Intentionally open | Section 15 stays empty; do not implement by inference |
| Portable spot-check versus continuous attachment | Recommended default, not finalized | Carry between assets for verification; continuous monitoring comes from existing telemetry or separately deployed modules |
| Native iPhone app versus mobile web | Open | Design shared workflows responsively; do not require a native app or choose a hardware connection through it |
| Arduino UNO R4 WiFi | Candidate | Reuse if allocated and available; hardware availability for this project must be confirmed |
| Exact sensor breakout models, mounting and power | Open engineering choices | Bench-test and document before final wiring |
| Airflow sensor | Recommended extension | First additional measurement if parts and time permit |
| Branding | Open | Clear descriptive name; no claim of uniqueness without checking |
| Visual system | Previously chosen user direction | IBM Carbon White / Gray 10 and IBM Plex; no return to rejected pine/mint/copper styling |

## 3. Intended users and organization

### Roles

| Role | Primary responsibilities | Main interface |
| --- | --- | --- |
| Operations supervisor / dispatcher | Triage incidents, compare options, assign/reassign tasks, coordinate shifts | Desktop operations map and priority queue |
| Engineer / specialist | Review dependencies, interpret evidence, approve applicable plans and completion | Incident and scenario detail |
| Field technician | Accept work, navigate, verify identity, perform checklist, report evidence and blockers | Phone-friendly task workspace |
| Incoming shift lead | Review open risks, unfinished work, recent decisions and ownership | Shift handoff |

Role labels in a local demo are not production authentication. Production permissions require server-enforced organization/site/role checks; do not claim secure multi-user authorization from a persona dropdown.

### Organization model

Use **organization → site → building → floor → zone → equipment**. Employees have a home team, permitted sites/zones, relevant skills, shift, availability and assigned work. An employee may be eligible for several zones but unavailable for a specific task.

A task belongs to a site and usually an incident and an equipment asset. An incident can create several tasks with different owners and prerequisites. Keep the responsible shift lead visible even when the task is unassigned or blocked.

The dashboard should organize work by **what needs attention, who owns it, where it is, what is blocking it, and what evidence is still missing**.

## 4. Product scope

### Required first release

- Clear landing page with an honest demonstration entry point.
- Interactive 2D facility map with assets, zones, floors, dependencies, employee check-ins and task destinations.
- Seeded facility telemetry, freshness/source labels, alerts, technical logs and maintenance documents.
- Verification sessions comparing relevant installed measurements with independent reference measurements.
- Explicit evidence states: corroborated abnormal condition, measurement disagreement, inconclusive, or no corroboration observed.
- Grounded Nemotron incident analysis with citations and transparent no-key fallback.
- Deterministic scenario comparison and an explainable incident/action priority queue.
- Employee roster, availability, skills, assignments and location freshness.
- Human-approved task delegation, acceptance, navigation, checklist execution, evidence collection, review and completion.
- Append-only operational history and a useful shift handoff.
- Existing cited dependency-discovery and confirmation workflow, feeding supported engine relationships.
- Clearly labeled simulated data and repeatable demonstration scenarios.
- Hardware measurement purpose, physical design and bench verification plan. Sensor connection remains out of scope until selected.

### Exclude from the initial build

- Automatic production shutdowns, workload migrations or electrical switching.
- Claims of guaranteed sensor-fault diagnosis, validated failure probabilities, remaining useful life, or CFD accuracy.
- Automatic indoor employee tracking without a real positioning system.
- A native mobile app, AR guidance or 3D facility reconstruction as a prerequisite.
- Full inventory purchasing, enterprise messaging integration, autonomous staffing or full ERP functionality.
- A proprietary hardware connection or a paid cloud dependency chosen without a separate decision.

## 5. Landing page: description, copy and organization

The landing page explains the product to a judge or first-time visitor. The operations app opens directly into work after **Open demo / Open workspace**. Do not put a large sales hero inside the dashboard.

### Page sequence

| Section | Content | Purpose |
| --- | --- | --- |
| Header | Working brand, How it works, Platform, Hardware, Open demo | Short orientation and direct entry |
| Hero | Headline, one specific explanation, actual dashboard image or clearly labeled product illustration | Establish the problem and solution quickly |
| Incident example | Two simultaneous warnings, independent evidence, updated action order | Demonstrate the distinctive decision |
| Workflow | Verify, prioritize, dispatch, complete, hand off | Explain a connected product, not a list of unrelated AI features |
| Platform preview | Facility map, priority queue, technician task screen, handoff | Show concrete operator work |
| Portable verification | What temperature, humidity, vibration and liquid probes measure; limits of the conclusion | Explain the physical component honestly |
| Coordination | Skills-aware assignment, employee check-ins, equipment routes, task evidence | Demonstrate team value |
| Final action | Open demo; short note that facility data is simulated | Make the product easy to try |

### Suggested copy

**Hero headline:** Know which warning to trust—and what to fix first.

**Hero description:** Verify equipment conditions, compare the consequences of competing incidents, and guide the right technician through the next action—all from one shared facility map.

**Primary action:** Open demo.  
**Secondary action:** See the workflow.

**Hardware section:** An independent physical cross-check. Portable probes help teams compare reported conditions with measurements taken at the equipment. Disagreement becomes a verification task, not an automatic dismissal of the alarm.

Use real product content, actual implemented screens when available, accessible contrast and restrained motion. No invented customer logos, uptime claims, savings, testimonials, sensor accuracy, integration status or “AI confidence” numbers. Do not show a working hardware connection diagram while Section 15 is blank.

## 6. Application information architecture

| Area | Main content | Primary actions |
| --- | --- | --- |
| Operations | Priority queue, facility map, employees, selected incident/asset | Inspect, verify, compare, assign |
| Incidents | Grouped alerts, evidence, hypotheses, impact and response history | Investigate, link task, acknowledge, escalate |
| Tasks | Work board/list, owner, prerequisites, location, due/review state | Assign, accept, begin, block, submit, review |
| Team | Employees, roles, skills, shift and location freshness | Check in, update availability, view workload |
| Scenario lab | Frozen baseline, proposed actions, service impact and ranking rationale | Compare, inspect assumptions, select response |
| Dependencies | Imported sources, cited candidate relationships, review, graph revisions | Import, confirm/reject supported changes, replay |
| Handoff | Open incidents, owners, unfinished tasks, decisions and uncertainties | Acknowledge, add note, export |
| Settings | Fixture reset, provider configuration status, thresholds, audit | Configure documented options, inspect diagnostics |

A tab is justified by real work. Related data must link back to the same equipment, incident, task and evidence records; avoid duplicate copies with divergent status.

## 7. Operations dashboard and map

### Desktop composition

- **Left:** ranked response queue. Each row shows incident/task title, affected services, evidence state, priority reason, owner and next action.
- **Center:** 2D facility map. Assets and routes have consistent geometry; employees and task destinations use distinct labeled symbols.
- **Right:** contextual inspector. Switch between equipment, incident, employee and task details without losing map context.
- **Recent activity:** compact log/drawer for operational events; a full history remains available through the incident/task/handoff.

Use a map/list alternative. Pan, zoom, reset, floor selection, search and filters must work. Show physical cooling/power relationships separately from logical service dependencies and employee walking routes.

### Employee mapping

For the first prototype, locations come from **manual check-in or optional QR/location-marker check-in**. Show “last checked in at Zone B, 6 min ago,” not a moving dot implying live indoor GPS. Seeded positions must be visibly simulated.

Each employee location stores floor, zone, waypoint, timestamp and source. Unknown or stale positions stay labeled unknown/stale. Do not animate an employee along a route unless actual updates arrive; a planned route is not observed movement.

Clicking an employee opens current task, availability, authorized zones, relevant skills and last reported location. Clicking an assigned task focuses its destination and offers a route from that employee's last valid check-in or a manually chosen starting point.

### Equipment identity

Use persistent asset IDs and human-readable names. Include row, rack, slot or service-access side where relevant. A correct room is insufficient if the employee might work on the wrong PDU or rack. Require an asset-ID confirmation before equipment work starts.

## 8. Employee guidance and routing

Represent the walkable facility as a graph of **waypoints and traversable edges**, separate from equipment dependency edges. Floors connect through explicit stairs/lifts. A route ends at the appropriate equipment service-access point, not through the equipment footprint.

Use Dijkstra or A* for the prototype. Edge metadata can include distance, floor transition, closed/blocked state, access permission and allowed direction. A shortest route that crosses a closed aisle or unauthorized door is invalid.

Route results include start source/freshness, destination asset and access side, waypoint sequence, distance, estimated walking duration with stated assumptions, blocked segments and any required access action. If no valid route exists, show the reason and escalate/reassign; do not draw a straight line through walls.

On a phone, show the next waypoint, destination ID, compact floor map, textual directions and a manual arrival confirmation. Optional camera-based QR confirmation must have a manual asset-ID alternative. Do not require indoor positioning or AR to complete a task.

Routing must not decide incident priority by proximity alone. A nearby low-impact task should not outrank an urgent service-threatening incident simply because it is closer. If a closure, reassignment or valid new check-in changes the route, recompute and record the relevant event.

## 9. Task delegation and scheduling

### Task record

A task includes type (verify/inspect/repair/monitor), incident, destination equipment, required skills, authorized zone, estimated duration, checklist, prerequisites, owner, status, priority rationale, evidence requirements and completion-review requirement.

### Assignment workflow

1. An incident or operator creates a proposed task. AI-generated instructions remain a draft with evidence and the applicable runbook version.
2. Filter employees by required skills, access permission, shift/availability and task prerequisites.
3. Rank eligible employees using travel estimate, current workload, continuity with the incident and available time. Display why a suggestion was made.
4. Supervisor confirms assignment, or chooses another eligible employee with a recorded reason. Automatic dispatch is not required for the MVP.
5. Technician accepts or declines with a reason. Until accepted, the supervisor retains responsibility for unowned work.
6. Reassignment preserves the prior owner, work completed, evidence, route state and reason. Do not silently reset the checklist.

Default to one active physical-work task per technician. Allow waiting/monitoring tasks without pretending they require continuous attention; model that distinction explicitly. A task blocked by parts, access or an upstream task must surface its blocker and escalation owner.

Use a scheduling preview to compare candidate response sequences. Respect prerequisite order and staff contention. No scheduling feature may assume the same technician performs two exclusive tasks at the same time.

## 10. Task execution and completion

### State machine

`unassigned → assigned → accepted → en_route → at_asset → in_progress → submitted_for_review → completed`

`blocked`, `cancelled` and `reopened` are explicit branches with actor, reason and time. A simple inspection may use a documented direct-completion rule; repairs and disputed high-impact checks require review by default. Do not require every task type to perform irrelevant steps.

### Field workflow

- Accept task and inspect destination, priority reason, prerequisites and required tools.
- Open route, arrive and confirm the equipment ID.
- Follow the relevant checklist, recording required observations or measurements and pass/fail/not-assessed outcomes.
- Link evidence to the step and incident. Do not turn an unavailable measurement into a normal value.
- Mark a blocker immediately if the task cannot proceed.
- Submit findings, proposed conclusion, remaining concerns and follow-up needs.
- Reviewer accepts completion, requests more evidence, or reopens the task. Preserve the original submission.

### What “complete” means

A task is complete only when its required checklist, equipment identity, evidence and review policy are satisfied. Clicking a checkbox is not proof of repair. Distinguish **work completed**, **condition rechecked**, and **incident resolved**.

For example, a technician may complete an inspection that identifies a probable failed fan while the incident remains open awaiting replacement. A repair task may finish while a monitoring task remains active. Incident resolution requires an explicit authorized decision supported by the post-action state or a documented exception.

Capture completion time, completing employee, reviewer where required, source/runbook version, evidence IDs, remaining risks and any follow-up task. Failed checks should remain visible in the handoff.

## 11. Shared log and shift handoff

Maintain linked views of the same append-only event history:

- Technical telemetry/log evidence, including timestamps and sources.
- Alert and incident lifecycle.
- Verification session start, site/asset identity, measurements, comparison and verdict.
- AI analysis with actual provider, citations and model/version metadata.
- Dependency proposal, human review and graph revision.
- Scenario snapshot, actions, assumptions, result and selection rationale.
- Task creation, assignment, acceptance, arrival, checklist evidence, blockers, reassignment, submission, review and completion.
- Employee check-ins and availability changes relevant to work.
- Shift acknowledgement and unresolved follow-up ownership.

Each event has a unique ID, actor/source, event time, ingestion time and entity links. Corrections append a superseding event; do not erase the original event to make the history look clean. Filter by asset, incident, task, employee, source and time.

The shift handoff should answer: **What is happening? What is verified? What is uncertain? What did we do? Who owns the next action? What must not be repeated without checking?** Include stale measurements, pending reviews, open/blocked tasks, recent assignments, suspected sensor problems, changed dependencies and approved-but-not-performed actions.

Provide Markdown or JSON export using the stored record, with generation time and data-source labels. Persist across reload and show the same records in a second browser tab.

## 12. Hardware purpose and physical architecture

The portable module is an independent verification instrument. It helps corroborate an abnormal condition or expose disagreement with installed telemetry. It does not universally distinguish every sensor fault from every equipment fault.

“External” means the intended reference measurements do not require modifying the monitored equipment. A contact accelerometer may attach to a housing; an air probe sits near a defined inlet/outlet; a leak probe sits near the suspected liquid path. These are different locations and quantities.

Recommended physical form: one portable electronics hub, a firm equipment-contact mounting point for vibration, a ventilated temperature/humidity probe away from controller self-heating, and a detachable liquid-presence probe. Use labeled connectors, cable strain relief and a simple asset/probe ID label. Exact enclosure, mounting, power and component choices need bench validation.

A portable inspection covers the inspected location and time window only. It does not continuously watch every rack when carried elsewhere. Existing facility telemetry or additional deployed modules would supply continuous coverage.

## 13. Sensors and candidate parts

| Measurement | Intended use | Candidate / implementation direction | Important boundary |
| --- | --- | --- | --- |
| Air temperature | Compare a relevant installed air-temperature reading; identify local heating | SHT31-class temperature/humidity breakout | Ambient air does not directly verify internal CPU temperature |
| Relative humidity | Environmental moisture context; optional derived dew point | Same combined sensor | Humidity is not liquid presence; derived dew point is not an independent measurement |
| Vibration | Detect operating-state or vibration changes on fans/pumps | Three-axis ADXL345-class accelerometer for the bench prototype | Mounting, bandwidth, sampling and load/speed matter; no universal bearing diagnosis |
| Liquid presence | Corroborate liquid at a particular location | Spot probe or leak rope; existing water sensor only after identification and testing | Dry at one point does not exclude a leak elsewhere; coolant conductivity can differ |
| Airflow | Help check whether a reported fan/cooling path actually delivers air | Optional suitable airflow probe | A first extension; placement and units must be characterized |
| Surface temperature | Compare accessible housing or pipe conditions | Later contact probe | Must not be confused with air or internal temperature |
| Differential pressure / liquid flow | More detailed cooling investigation | Later installed/specialized instrumentation | Not assumed available from a simple external puck |

A basic vibration switch measures a threshold event, not a useful spectrum. Use an accelerometer when claiming vibration magnitude/features. Compare to a known operating baseline, retain sampling rate/range and attach quality flags. Start with relative RMS/peak change and a documented operating-state distinction. Spectral analysis is optional and should not become a false diagnostic claim.

### Candidate bench bill of materials

| Component | Quantity | Status |
| --- | --- | --- |
| UNO R4 WiFi or another suitable controller | 1 | Candidate; confirm actual allocation before choosing firmware |
| Documented temperature/humidity breakout | 1 | Candidate; verify exact board voltage/interface compatibility |
| Documented three-axis accelerometer breakout | 1 | Candidate; verify mount, data rate and usable signal |
| Liquid-presence probe | 1 | Candidate; identify any existing sensor first |
| Breadboard/prototype board, connectors and leads | As needed | Confirm availability |
| Enclosure, mounting hardware and strain relief | 1 set | Prototype mechanically, then print if useful |
| Appropriate power source/cable | 1 set | Select after measuring requirements; no battery-life claim yet |
| Guarded low-voltage fan/motor demo stations | 2 preferred | Demonstration equipment, not production infrastructure |
| Airflow probe | Optional | Add only after the core measurement path works |

UNO R4 WiFi has an RA4M1 controller and ESP32-S3 connectivity hardware [S3]; this is a capability fact, not a selection of the project's sensor connection. Adafruit documents regulated/level-shifted ADXL345 and SHT31 breakout options [S4, S5]. Do not assume all generic boards with those chip names tolerate the same supply or logic levels. Exact wiring, libraries, prices and stock must be checked against the purchased boards; no purchase is authorized by this handoff.

## 14. Measurement validity and verification verdicts

Compare like with like: quantity, location, units, time window and operating condition must be appropriate. Include response/settling time and uncertainty or repeatability limits. A fresh air reading in front of a rack cannot invalidate a high internal semiconductor reading.

| Evidence | Allowed verdict | Required next step |
| --- | --- | --- |
| Comparable installed and reference readings are both abnormal | `corroborated_abnormal` | Investigate the equipment/environment; assess downstream impact |
| Comparable readings materially disagree after quality checks | `measurement_disagreement` | Investigate sensor, location, calibration, timing or telemetry chain |
| Wrong location, stale data, missing baseline, unstable mount or conflicting signals | `inconclusive` | Repeat/relocate measurement or obtain another relevant signal |
| Reference session does not reproduce the reported issue | `not_corroborated_in_session` | Keep the original alert and context; intermittent faults remain possible |

Do not label disagreement as “sensor definitely broken,” or no corroboration as “equipment safe.” A definitive fault claim needs an appropriate validation procedure and supporting evidence. Portable measurements do not automatically dismiss alerts or authorize equipment actions.

Verification sessions store the asset ID, measurement point/method, probe ID, time window, units, quality flags, comparable telemetry, baseline/context and operator conclusion. The reference probe's own heartbeat/calibration/health metadata must not be confused with the monitored equipment's state.

## 15. Sensor connection

## 16. AI implementation and responsibilities

Use NVIDIA Nemotron server-side for evidence synthesis and structured planning. The current prototype has optional configuration through `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, `NEMOTRON_MODEL` and `NEMOTRON_TIMEOUT_MS`. Recheck supported endpoint/model identifiers against current official NVIDIA documentation before a live deployment; the existing configured default is not proof of availability.

### Inputs

Only relevant evidence: timestamped telemetry/logs, verification records, maintenance history, runbooks, confirmed dependency graph, active incidents, task state, staff skills/availability and deterministic scenario results. Keep a record of exactly what snapshot and sources each analysis used.

### Outputs

- Observations and cited supporting evidence.
- Plausible causes, competing explanations and unresolved questions.
- Recommended next verification or repair task, with purpose and prerequisites.
- Suggested response options expressed as supported engine actions.
- Interpretation of calculated impacts and an explainable priority recommendation.
- Suggested eligible employees, with skill/access/workload reasoning.
- Draft task checklists derived from cited runbooks, subject to review.
- Draft shift summary from stored events.
- Proposed missing dependencies supported by exact source quotations.

### Boundaries

Nemotron does not invent telemetry, calculate authoritative thermal/impact numbers in free text, silently modify the confirmed graph, certify a fault, complete a task, assign privileged work autonomously, move employees on the map, or execute production infrastructure commands.

Validate JSON using bounded schemas. Check entity IDs and citations, verify exact quotations, and refuse unsupported action/relationship types. Treat documents and logs as untrusted evidence, not instructions. Do not allow model text to execute arbitrary tools, SQL or shell commands.

Show the actual provider and whether the response is live AI, local rules or a replayed fixture. On missing key, timeout, invalid JSON or upstream failure, preserve the operator workflow using clearly labeled local analysis. General unstructured-document understanding must not be claimed for a narrow deterministic demo parser.

### Why AI is useful here

Its valuable work is connecting fragmented evidence, extracting documented relationships, generating context-sensitive investigation plans and explaining the tradeoffs between responses. The sensor, graph, routing algorithm and deterministic simulation make its recommendations checkable. The product's credibility depends on those boundaries.

## 17. Dependency discovery and confirmation

Retain the existing workflow: import pasted text or `.txt`/`.md` → extract candidate → inspect quotation → confirm/reject → new graph revision → replay the same prediction.

The current engine supports confirmed cooling-coverage changes only. A cooling replacement must target an existing confirmed cooling relationship to the same rack and retain explicit coverage/capacity semantics. Supersede the old edge atomically; do not merely add a graphical connection or duplicate capacity.

Unconfirmed/rejected proposals never affect calculation. Confirmation must revalidate source quotation/offsets, endpoint types, target edge and finite positive capacity. Unsupported physical relationship types remain unconfirmable into this engine until that model integration is implemented and tested.

Bind scenario results to graph/model versions. Mark earlier proposed actions stale when a relevant graph changes; do not silently approve them against a different model. Preserve the prior result and distinguish documentary confirmation from a physical measurement.

## 18. Scenario engine and incident prioritization

### Division of work

Nemotron may request supported scenarios and explain their results. The engine performs repeatable calculations over a frozen baseline, verified topology, proposed actions, model parameters and time horizon. No LLM-generated number should masquerade as an engine output.

For multiple incidents, evaluate small candidate action sequences rather than separately ranking raw alert values. Include shared cooling/power capacity, redundancy, service replicas, dependencies, staffing, travel and prerequisites where modeled. Report unsupported factors explicitly.

### Ranking policy

| Factor | Required treatment |
| --- | --- |
| Service impact | Affected services and operator-defined criticality; do not invent revenue |
| Urgency | Trend or model-estimated deterioration under stated assumptions |
| Redundancy | Remaining healthy paths and whether a next failure removes protection |
| Evidence quality | Corroborated, disputed, stale, missing or inconclusive |
| Response benefit | Compare doing nothing, verification, mitigation and repair where supported |
| Resource feasibility | Eligible people, tools/parts status, travel and task contention |
| Consequence of an incorrect action | Identify whether action could remove capacity or worsen another incident |

Use a transparent policy version and breakdown. Avoid an unexplained “AI priority 97.” Unknown probabilities should remain unknown; an uncalibrated confidence score is not a failure probability. If quantitative weights are used for the demo, label them as operator-configured illustrative weights.

A useful default is: enforce operational constraints first, compare modeled service disruption and lost redundancy, then compare feasible completion time and uncertainty. When ranking depends on unknown evidence, recommend a specific check that would resolve it. Do not lower a dangerous alert merely because one reference reading disagrees.

### Prediction contract

Store baseline ID, model version, graph revision, action sequence, horizon, task/staff assumptions, before/after metrics, affected services/racks, propagation path, constraint violations, result quality and explanation. Replay before/after a dependency change using the same operational inputs, actions and horizon.

The current thermal/power engine is a demonstration model, not validated facility physics. Show estimated threshold crossings conditionally; do not promise exact outage timing. Employee routing and simulated equipment propagation are separate models and must not share edge types accidentally.

## 19. Backend and application architecture

Reuse the existing local TypeScript product where practical:

| Layer | Current / intended role |
| --- | --- |
| React + Vite | Responsive landing page and operator/technician interfaces |
| Express API | Domain operations, validated requests and server-side integrations |
| SQLite via `node:sqlite` | Persistent operational records and transactions |
| SSE | Updates to connected app views; reconnect and deduplicate |
| Pure domain modules | Equipment simulation, scenario math, verification rules, priority policy and routes |
| Nemotron adapter | Bounded evidence-based analysis and structured proposals |
| Hardware | Independent measurement instrument; connection unspecified |

Keep a single shared domain model for desktop and phone views. Do not create a second task database for a mobile interface. The landing page can live at `/`, with work under `/app`; preserve existing app URLs through an intentional routing migration rather than breaking bookmarks.

For local development, retain the one-command app startup. The existing app uses Node.js 26+ and npm; verify actual installed versions. A phone cannot reach a laptop's `127.0.0.1` address. Any real phone test needs a deliberately configured reachable app address and appropriate access controls, which are separate from the unselected sensor connection.

Keep NVIDIA credentials server-side. Validate organization/site membership and transitions on the server. Use bounded uploads and content validation. Report stale/offline evidence honestly. Do not expose a development server publicly just to make a demo work.

## 20. Data model and evidence contract

These are proposed domain additions, not assertions that the current schema already has them.

| Record | Important fields |
| --- | --- |
| Organization / Site / Zone | IDs, hierarchy, floor, map reference, permitted access |
| Equipment | Persistent ID, type, map footprint, service-access waypoint, linked documents |
| Employee | ID, team, role, skills, permitted zones, shift, availability |
| EmployeeLocation | Employee, zone/floor/waypoint, observed time, source, freshness |
| Incident | Asset, alerts, severity, evidence state, owner, status, linked tasks |
| Task | Type, destination, incident, required skills, prerequisites, estimate, status, review policy |
| TaskAssignment | Task, assignee, assigning actor, acceptance/decline, start/end and reason |
| Checklist / StepResult | Versioned procedure, required steps, outcome, evidence and completion time |
| Evidence | Type, source, event/ingestion time, units, quality, asset and stable evidence ID |
| VerificationSession | Asset, measurement point, operator, comparable evidence IDs, quality and verdict |
| Dependency | From/to/type, confirmation state, evidence, coverage/capacity and graph revision |
| Scenario | Frozen baseline, proposed actions, graph/model/policy versions and results |
| Route | Employee/start source, destination, path, access/closure assumptions, generated time |
| OperationalEvent | Append-only actor/source, entity links, event type, payload and timestamps |
| Handoff | Snapshot time, open risks, task owners, pending reviews, acknowledgements |

Preserve measurement provenance, units and source quality regardless of how readings are entered later. This document intentionally defines no hardware packet format or transport API.

## 21. Proposed application APIs

Names below are illustrative contracts to reconcile with the existing API, not automatic replacements.

| Capability | Proposed operation |
| --- | --- |
| Facility and evidence | Read map, assets, telemetry and incident evidence |
| Team | Read employees; update permitted availability; append location check-in |
| Tasks | Create, assign, accept/decline, transition, record step evidence, block, submit, review/reopen |
| Routing | Request route using validated start/destination and access constraints |
| Verification | Create session, link existing evidence, record comparison and operator verdict |
| Priority | Evaluate incidents/actions on a stored snapshot and return factor breakdown |
| Scenarios | Compare and replay supported engine actions |
| Knowledge | Import sources, extract candidates, review supported relationships |
| Log and handoff | Read filtered events, acknowledge handoff, export stored report |

Require legal transitions, idempotency for retryable mutations, stale-version checks for contested assignment/approval, and server-side permission checks. A second tab must not complete a reassigned task using a stale owner/version. Sensor ingestion, device pairing and hardware transport routes are intentionally absent.

## 22. Existing codebase: verified baseline versus new work

**Local prototype:** `Relay/` under the HackUTD project workspace.  
**Checkpoint inspected for this handoff:** `9fcd0a2` — Follow Carbon design and add cited dependency discovery with topology-aware replay.

### Earlier implementation already reported and documented

- Seeded 16-rack facility, map/list and inspector.
- Cooling and PDU incident simulations.
- Deterministic thermal/power scenario calculations and simulated response approval.
- Evidence-linked local analysis and optional Nemotron adapter.
- Source import, exact quotations, supported cooling confirmation, graph revisions and frozen replay.
- Persistent events/notes, shared handoff and exports.
- Carbon redesign, IBM Plex fonts and responsive inspector work.

The recorded earlier Freebuff release run passed **19 domain/API tests and 6 Playwright journeys**, typecheck, production build and diff checks. Those results cover the earlier checkpoint only. They do not validate new hardware, employee dispatch/routing, a landing page or the expanded completion workflow. The coordinating workspace independently passed typecheck/build but could not bind its API test server; it did not independently pass that API suite. Live Nemotron remained unverified without a key.

### Files to inspect first

| Path relative to `Relay/` | Responsibility |
| --- | --- |
| `README.md`, `TESTING.md`, `DEMO.md` | Existing run instructions, evidence and limitations |
| `src/App.tsx`, `src/styles.css` | Shell, navigation and Carbon styling |
| `src/components/FacilityMap.tsx` | Current SVG map and accessible list |
| `src/views/KnowledgeView.tsx` | Source review and frozen replay |
| `src/views/ScenarioLab.tsx` | Existing comparison UI |
| `server/api.ts`, `server/db.ts` | API state and persistence |
| `server/model.ts`, `server/topology.ts` | Seeded model and confirmed graph projection |
| `server/simulator.ts`, `server/scenario.ts` | Current engine |
| `server/knowledge.ts`, `server/nemotron.ts` | Extraction and model integration |
| `shared/types.ts` | Shared contracts |
| `tests/domain/`, `tests/api/`, `tests/e2e/` | Regression coverage |

The current custom scenario UI adds one action per custom option, whereas one existing discovery demo uses a multi-action option prepared through the tested API. Improve that workflow if the demo depends on it; do not imply the current UI already composes arbitrary multi-action plans.

## 23. Visual design specification

Follow the previously selected **IBM Carbon White / Gray 10** system and productive typography [S6]. Do not invent another theme.

| Role | Token / treatment |
| --- | --- |
| Main surface | `#ffffff` |
| Subtle surface | `#f4f4f4` |
| Primary / secondary text | `#161616` / `#525252` |
| Separators | `#e0e0e0` |
| Primary action / focus | `#0f62fe` |
| Primary hover | `#0043ce` |
| Inverse navigation | `#161616` with appropriate light text |
| Body | Self-hosted IBM Plex Sans, 14px / 20px |
| Helper text | 12px / 16px where readable |
| Section / page heading | Restrained 16px / 24px and 20px / 28px hierarchy |
| Technical values | IBM Plex Mono only where useful |
| Layout | Flat rows/tables, square controls, deliberate 4/8/16/24px spacing |

Remove unnecessary pills, dots, ornamental brand marks, repetitive captions and card nesting. Keep semantic status words, clear selections, accessible legends and functional route/asset/employee markers. Employee symbols should communicate role or assignment; decorative moving dots are inappropriate.

Check desktop, 960/961px transitions, tablet and 390px narrow views. The map should not squeeze an unreadable inspector into a thin column; use an accessible drawer/overlay. Tables and forms need useful narrow layouts. Check actual rendered views and typography; compilation does not establish visual quality. Preserve keyboard navigation, visible focus, contrast and reduced motion.

## 24. Lessons from prior HackUTD winners

These are documented workflow inspirations, not copied layouts or independently verified production claims.

| Project | Verified award on Devpost | Pattern to adapt |
| --- | --- | --- |
| DataDriver | Northmark and NVIDIA | Adaptive maintenance plans, inventory-aware blockers and replanning when evidence changes [S7] |
| TaskFlow | Northmark | Engineer oversight, technician checklists, progress and equipment-specific communication [S8] |
| DCDaddy | Northmark | Task-linked floor plans, customer-impact/technician views and work-order grouping [S9] |

Do not infer first/second/third order from the gallery. Keep their coordination strengths while centering this project's independent verification and evidence-driven action priority. The competitive distinction is the full path from a disputed warning to a verified action and accountable completion, not simply adding a chatbot to a floor plan.

## 25. Demonstration plan

### One connected story

A supervisor sees two competing warnings. One is a misleading simulated installed-sensor reading; the other corresponds to a real measurable operating change at a low-voltage bench cooling station. The technician verifies conditions with the portable instrument, and the software re-evaluates the next action using the evidence and equipment/service model. The supervisor assigns a suitable employee, whose checked-in location supports a valid route to the correct asset. The employee confirms identity, performs the checklist, submits evidence and receives completion review. The incoming shift sees what changed and what remains uncertain.

Because the hardware connection is unselected, the initial story must use clearly labeled manual/fixture reference evidence. It is not an integrated-hardware demo until a connection is separately chosen, built and tested. Physical bench measurements can be demonstrated independently without implying live app delivery.

### Suggested three-minute sequence

| Time | Screen / action | Evidence of value |
| --- | --- | --- |
| 0:00–0:20 | Landing page → Open demo | Explain the warning/verification/response problem |
| 0:20–0:45 | Operations map and two alerts | Show shared services, staff and competing incidents |
| 0:45–1:15 | Verification session | Compare relevant readings; expose disagreement versus corroboration |
| 1:15–1:40 | AI investigation and scenario comparison | Explain priority using citations and calculated impact |
| 1:40–2:05 | Assign task and show employee route | Demonstrate skills/access/availability and correct destination |
| 2:05–2:40 | Technician task | Confirm asset, perform checks, submit evidence, reviewer completes |
| 2:40–3:00 | Shared log and handoff | Show ownership, recorded decisions and unresolved follow-up |

Do not rely on room temperature changing dramatically in seconds. Choose a repeatable bench signal, retain timestamps and label accelerated/simulated thermal propagation. No damage to real equipment or invented physical readings is needed.

### Reset and fallback

A single documented reset should restore fixture telemetry, incidents, employee check-ins, tasks, route closures and graph state coherently. It must not delete unrelated user records. Provide a known starting state, pause controls and a deterministic no-key analysis path. Saved screenshots or recordings are backups, not proof that a disconnected module is integrated.

## 26. Build sequence and task delegation for the implementation team

The following are work packages, not claims that independent agents have been launched. Follow the user's existing preference that Freebuff handles orchestration; use real subagents only if that host actually provides them, otherwise record serial role passes honestly.

| Work package | Owns | Dependencies | Completion evidence |
| --- | --- | --- | --- |
| Product / architecture | Scope, data contracts, state transitions, supported models | Read this handoff and current code | Written contracts and pre-build acceptance cases |
| QA design | Failing/acceptance cases for new workflows | Product scope | Tests/checklist derived before implementation |
| Domain/backend | Employees, tasks, event persistence, permissions, verification comparisons | Shared contracts | Domain/API tests and reload persistence |
| Routing | Waypoint graph, constrained route calculation, arrival destination | Map and employee location contracts | Accessible/blocked/multifloor path tests |
| AI integration | Grounded analysis, action proposals and ranking explanation | Evidence and engine contracts | Schema/citation/fallback tests; live call only if configured |
| Operations UI | Priority queue, map, employees and assignment inspector | APIs and map contracts | Rendered desktop/mobile interaction evidence |
| Field UI | Acceptance, navigation, identity, checklist, blocker, submit/review | Task/routing APIs | Full technician browser journey |
| Landing page | Honest copy, product sequence, real previews and entry flow | Chosen design system | Rendered page and working entry route |
| Hardware bench | Sensor identification, mounting, sampling and validity | Available parts | Recorded bench observations; no connection claim |
| Sensor connection | Unassigned | Separate user decision | No work in this handoff |
| Integration / critic | Consistency, regressions, accessibility and claim audit | Completed slices | Full check results, screenshots and known limits |
| Demo / release | Seed/reset, runbook, environment, final evidence | Integration | Repeatable demo and honest release report |

Implement vertical slices: one incident → one verification → one assignment → one route → one completion → one handoff, then extend to competing incidents and prioritization. Avoid building six disconnected mock dashboards before proving the shared record.

## 27. Acceptance criteria

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| A01 | Landing page explains the specific workflow and opens the real app | Browser journey; no dead CTA or fabricated claims |
| A02 | One asset/incident/task identity persists across all views | API and browser checks |
| A03 | Stale, missing, simulated and reference measurements remain distinguishable | Domain tests and rendered states |
| A04 | Disagreement does not automatically assert sensor failure or clear an incident | Verification-rule tests |
| A05 | Imported/unconfirmed/rejected dependencies do not change engine output | Regression tests |
| A06 | Supported confirmation changes the actual model and invalidates stale approvals | API and frozen-replay tests |
| A07 | AI cites stored evidence, validates entities and reports provider/fallback accurately | Mock payload/failure tests; live proof only if configured |
| A08 | Multi-incident priority exposes rationale, assumptions and feasible next actions | Fixed-fixture ranking and scenario tests |
| A09 | Skills, availability, access and prerequisites constrain suggested assignments | Domain/API tests |
| A10 | Concurrent assignment/acceptance updates cannot silently overwrite ownership | Stale-version/idempotency tests |
| A11 | Employee position has source/time; stale position never masquerades as live tracking | Map/UI tests |
| A12 | Route uses walkable authorized graph and correct service-access destination | Path tests with closed aisle and no-route case |
| A13 | Technician confirms equipment identity before work | Browser negative and positive cases |
| A14 | Required checklist/evidence/review controls completion | API state-transition and browser tests |
| A15 | Task completion does not automatically resolve an unverified incident | Lifecycle tests |
| A16 | Reassignment/reopening preserves previous work and reason | Persistence/event tests |
| A17 | Log and handoff show ownership, pending reviews and unresolved risks after reload | Two-tab/restart and export checks |
| A18 | Desktop, breakpoint and phone layouts retain map/list, inspector and task access | Rendered and Playwright checks |
| A19 | Hardware claims match bench-verified measurements and limitations | Bench record, probe IDs and fixture/source labels |
| A20 | No sensor connection is invented or implicitly implemented | Scope review; Section 15 remains blank |
| A21 | No automatic production commands or fictional model/provider success | Code and claim review |
| A22 | Demo reset restores a coherent isolated fixture | Reset test and repeated demo |

## 28. Verification and delivery

Use existing project commands as the starting point:

```bash
npm install
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run dev
```

Install the documented Playwright browser if absent. Add focused domain tests for verification states, priorities, assignments and paths; API tests for legal transitions, persistence and conflicts; browser tests for the full supervisor-to-technician-to-handoff workflow. Existing tests must remain meaningful and pass after changes.

A release report must name what ran, exit codes, tested viewports, actual hardware measurements, fixture-only behavior, provider status and unresolved defects. Render and inspect the landing page, operations, assignment, route, field completion and handoff states. Do not substitute DOM inspection for visual review.

Deliver source, lockfile, environment template without secrets, firmware/bench notes if applicable, startup instructions, fixture/reset procedure, architecture/model assumptions, test results and demo runbook. Keep sensor connection unimplemented until the separate decision. Preserve the earlier prototype unless deliberately changing it in a reviewable branch/checkpoint.

The baseline MAS copy came from `cklementine/hackathon-mas` commit `33bc5b847d236ec567b154564fcb66486e3cfb88`, checked earlier on November 7, 2026. That is a historical provenance statement, not a fresh claim that it is still upstream latest. Recheck before a new build if required. Do not modify the original MAS checkout or synced project `sources/`.

## 29. Copyable builder handoff

> Read this document in full before changing code. Continue the existing data-center prototype into a connected verification-and-response platform. Preserve Carbon White / Gray 10 and IBM Plex. Implement the landing page, organization/team model, evidence-based incident priority, task assignment/acceptance, explicit employee check-ins, constrained routes to correct equipment, checklist/evidence/review-based completion, shared log and shift handoff. Reuse the existing grounded analysis, confirmed cooling topology and deterministic scenario engine. Model-generated claims must be supported by stored evidence and actual engine outputs. Treat fixtures and no-key analysis honestly. Do not create a native mobile app as a prerequisite. Leave Section 15 and the entire sensor connection/transport/pairing/ingestion implementation empty; do not infer a connection from the candidate controller. Start by comparing this specification with the current code and writing acceptance cases, then implement one complete vertical workflow and expand it. Run appropriate tests, inspect rendered views, fix failures, document limitations and checkpoint the completed work. Never report the older 19/6 test result as validation of newly added features.

This is a handoff for future execution. Creating this document does not launch a build, change the current app, purchase parts or select a sensor connection.

## 30. Research and reference links

Sources below ground hardware capabilities, sensor placement and prior-project patterns. Proposed product behavior, workflows and architecture elsewhere in this document are design recommendations unless marked user-defined. No exact hardware prices, stock or metrological performance were verified for a purchased module.

- **[S1] Raritan data-center SmartSensors:** environmental sensor categories, rack inlet/outlet placement and deployment examples. https://www.raritan.com/eu/assets/uploads/Datasheets/RE_SmartSensor_DataSheet_R3_EN_WEB.pdf
- **[S2] Analog Devices vibration measurement guidance:** mounting, bandwidth and condition-monitoring considerations. https://www.analog.com/en/resources/technical-articles/2020/10/01/11/42/how-to-build-a-mems-based-solution.html and baseline context: https://www.analog.com/en/resources/technical-articles/2017/05/01/09/59/measuring-ac-accelerations-to-calibrate-or-not-to-calibrate.html
- **[S3] Arduino UNO R4 WiFi official hardware documentation:** controller and connectivity capabilities; exact pinout must be checked. https://docs.arduino.cc/hardware/uno-r4-wifi/
- **[S4] Adafruit ADXL345 assembly/wiring:** compatibility applies to the documented breakout, not every generic ADXL345 module. https://learn.adafruit.com/adxl345-digital-accelerometer/assembly-and-wiring
- **[S5] Adafruit SHT31-D wiring/test and Sensirion device page:** https://learn.adafruit.com/adafruit-sht31-d-temperature-and-humidity-sensor-breakout/wiring-and-test and https://sensirion.com/products/catalog/SHT31-DIS-B
- **[S6] IBM Carbon official color and type references:** https://www.carbondesignsystem.com/building-blocks/foundations/color/tokens and https://www.carbondesignsystem.com/building-blocks/foundations/typography/type-sets
- **[S7] DataDriver Devpost:** https://devpost.com/software/datadriver
- **[S8] TaskFlow Devpost:** https://devpost.com/software/d-68uye4
- **[S9] DCDaddy Devpost:** https://devpost.com/software/fun-dashboard
- **[S10] Existing Relay name collision:** https://devpost.com/software/tbd-v8pqbk
- **[S11] User-supplied prior-year submissions filter:** https://hackutd-2025.devpost.com/submissions/search?utf8=%E2%9C%93&prize_filter%5Bprizes%5D%5B%5D=92981

The 2025 links are prior-year references. They do not establish the current event's rules, prizes, submission deadlines or sponsor eligibility. Hardware/Carbon official references were checked during research on November 7, 2026; use current documentation for exact implementation.
