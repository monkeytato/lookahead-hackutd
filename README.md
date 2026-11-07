# Lookahead — know which warning to trust, and what to fix first

HackUTD 2026 · **Northmark Compute & Cloud: Keep the World Running**
*Working name. A data-center operations prototype; facility data is simulated, and rack measurements come from the Rack Monitor rig.*

> Data center teams run around the clock, and a missed warning, an unclear handoff, or wrong
> information at the wrong time can turn a small issue into a major outage.

Lookahead is a time-to-impact and handoff tool, not a crystal ball:

- It turns a facility's dependency graph into **countdowns with ranges**.
- It lets a technician **verify** a disputed reading with the Rack Monitor by holding a scan.
- It uses **NVIDIA Nemotron** to decide which what-if simulations to run and which scan would most change the plan.
- It **ranks** incidents with a visible breakdown.
- It **dispatches** the right person to the right asset.
- It **writes the shift handoff** from the stored record.

```
detect → verify → assess → prioritize → assign → navigate → complete → hand off
```

## Run it

```bash
npm install
npm run dev        # bridge (:8787) + web (:5173). Landing #/, workspace #/app, scanner #/scan
npm test           # engine, rig and director tests (vitest)
npm run typecheck
npm run build
```

`npm run dev` starts two processes:
- The **bridge** (`server/index.ts`) owns the Rack Monitor's USB serial port and the NVIDIA key.
- The **web app** reaches the bridge through `/api`.

With no Arduino plugged in, the bridge runs a **simulated rig** that emits byte-identical frames, labeled SIMULATED everywhere. Plug the rig in and the bridge switches to it within 5 s. To pin a port, set `RACKMON_PORT=COM5`.

- **Phone scanner:** run `npm run dev:lan` and open `http://<laptop-ip>:5173/#/scan` on the same Wi-Fi. The bridge itself stays on 127.0.0.1. There is no auth, so keep this on a trusted network.
- **Nemotron live:** put `NVIDIA_API_KEY=...` in `.env.local` (see `.env.example`). Without it, the deterministic local planner runs the same tool sequence and the UI says so.

Routes:

| Route | Screen |
| --- | --- |
| `#/` | Landing |
| `#/app` | Operations |
| `#/app/rig` | Rack node |
| `#/scan` | Scanner |
| `#/app/tasks` | Tasks |
| `#/app/team` | Team |
| `#/app/dependencies` | Dependencies |
| `#/app/log` | Log |
| `#/app/handoff` | Handoff |
| `#/app/field/<taskId>` | Technician |
| `#/twin-lab` | 3D twin alone |

## The rig → scanner → dashboard loop

```
Rack Monitor (UNO R4, USB JSON @1 Hz) ─► bridge ─► SSE ─► scanner app  (live numbers, hold to scan)
         ▲ flap / valve / fan commands      │            dashboard     (scan → evidence → verdict)
         └──────────────────────────────────┤            rack node     (acoustic vs reference, rig events)
                                            └─ /api/director → Nemotron simulation director
```

- **Hold to scan, 10 s.** The three acoustic beams take turns, and each averages about 25 pings, so all three refresh roughly every 5 s.
  - Releasing before **5 s** (one full cycle) discards the scan.
  - Holding to **10 s** (two cycles) completes it automatically.
  - The bridge computes the statistics from the frames it buffered, so a client can start or stop a scan but never send numbers.
  - Each channel reports mean ± sd, n and slope. Held acoustic values are de-duplicated so n counts real averages.
- **Scan → evidence.** A front-inlet scan becomes a reference reading compared against the installed sensor. A floor scan becomes liquid evidence. Both feed the same four verdicts. If the rig's own acoustic and reference readings disagree by more than 2 °C, the verdict is *inconclusive* and the scan should be repeated.
- **No accelerometer on this build.** Vibration incidents (CRAH-2) stay a runbook check, and the UI says so.
- **The rig's own rules** cover the ten situations from the wiring doc: power loss, single fan, recirculation, heat spike, cold-supply loss, leak at rack, leak elsewhere, outside water, obstruction and sensor fault. They run on the bridge and appear on the Rack node page. The flap and valve safety fixes run on the Arduino itself.

## NVIDIA Nemotron — the simulation director

Nemotron doesn't produce the numbers. It decides **which simulations to run, and which physical scan to take next.** The deterministic engine computes every clock. Nemotron calls the engine as tools:

1. `get_situation`: open incidents, evidence states, clocks and the latest rig scans.
2. `scan_value`: for each unverified incident, runs the engine **twice**, once assuming the reading is real and once assuming it isn't. The difference in first rack loss and in the top-ranked incident is the scan's **decision value**.
3. `run_scenario` and `compare_runs`: extra what-ifs the model chooses, such as a second fault or a confirmed dependency.
4. `recommend`: the next scan (asset, point, 10 s hold) and the next action. Every clock it quotes must cite a run id, and a validator strips any number no run produced.

**Send to scanner** turns the recommendation into a request on the phone, and the scan result comes back as evidence.

On the fixture at 02:35 it picks the BATT-B floor scan, with a decision value of 21.8: if wet, the first rack is lost in 19 min; if dry, no rack is lost within the hour.

- **Model:** `nvidia/nemotron-3-super-120b-a12b` via `integrate.api.nvidia.com`, with tool calling.
- **Fallback:** with no key, a timeout or invalid output, the local planner runs the same steps and the UI labels it.

## Demo script (2 min)

1. **Landing → Open demo.** The hall is quiet, in grayscale.
2. **Two warnings.** A-11 reports 34.2 °C, and CRAH-2 fan vibration has tripled. The queue ranks both and shows why.
3. **Verify A-11.**
   - On the A-11 incident, click **Request scan**.
   - The request appears on the phone (`#/scan`). Put the rig at the inlet and **hold to scan** for 10 s.
   - The dashboard records *measurement disagreement*: installed 34.2 °C vs about 22.5 °C from the rig. That makes it a verification task, not a dismissal.
4. **Play.** At 02:21 the make-up flow mismatch raises *possible leak*. Turn on the water layer and drag **Look ahead** forward. The wet front reaches UPS-B and BATT-B and the clocks start, following the Google Paris 2023 pattern compressed.
5. **Ask the director.**
   - Run the simulation director. It simulates both outcomes for each unverified incident and picks the scan that would change the order, here the BATT-B floor.
   - Send it to the scanner, wet the floor probe (or click *spill* on the Rack node page), and scan.
   - The water incident turns *corroborated*.
6. **Assign.** Suggestions filter on skill, zone access and availability. Pick one; the route starts from the person's last check-in and never cuts through walls.
7. **Technician view.** Accept, walk, and confirm the asset ID; a wrong ID is refused. Run the checklist and submit. The engineer approves, and the incident stays open until someone resolves it.
8. **Handoff.** It covers what is happening, what is verified, what is uncertain, who owns the next action and what not to repeat. Export it as Markdown or JSON, then acknowledge it as the incoming lead.

## What is real, what is simulated

| Piece | Status |
| --- | --- |
| Dependency graph and Monte Carlo clocks | Implemented, seeded and deterministic. Delay ranges carry their basis; most are **assumptions**. |
| Thermal model | Lumped first-order model, **indicative, not CFD**. |
| Water layer | Height-field diffusion on a 0.5 m grid. An **approximation** whose arrival times feed graph edges. |
| Sensor ↔ app connection | **USB serial, JSON lines at 1 Hz** → bridge → SSE. Firmware in `hardware/` is **not yet compiled or flashed**; tested against the simulated rig only. |
| Rig scans and rules | Implemented with tests. The live rig is untested until the hardware is flashed. |
| Verification verdicts | Rules over four explicit states. Evidence comes from Rack Monitor scans, with labeled fixtures as a fallback. |
| NVIDIA Nemotron director | Tool-calling agent plus a validator. Tested against a **mocked** endpoint; a live run needs `NVIDIA_API_KEY`. |
| Persistence | Dashboard: `localStorage` + `BroadcastChannel`. Bridge: scans, requests and events in `server/.data/`. Not production storage or auth. |
| People positions | Manual or QR check-ins only, with stale positions labeled. No indoor tracking. |

## Repo map

```
src/domain/types.ts        shared contracts: one record for every view
src/domain/fixture.ts      the simulated facility DAL-1 / Hall A, scenarios, people, runbooks
src/domain/engine/         pure engine: cascade, thermal, water, verification, priority, routing, tasks, handoff
src/domain/rig/            rig protocol, scan statistics, root-cause rules, simulated rig
src/state/                 store (reducer + persistence + cross-tab), bridge client, scan → evidence mapping
src/twin/                  3D digital twin (React Three Fiber)
src/views/                 operations, inspector, director panel, rack node, tasks, team, dependencies, log, handoff, field
src/scan/                  scanner app (hold to scan)
src/landing/               landing page
server/                    bridge: serial ↔ SSE, scans, rig commands. director/ = Nemotron agent + local planner
hardware/                  Arduino UNO R4 firmware + flash/bench guide
docs/                      ENGINE_CONTRACT, design brief, roadmap, research, original handoff
tests/                     engine/ rig/ director/ vitest specs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the team workflow and [docs/ROADMAP.md](docs/ROADMAP.md) for what's next.
