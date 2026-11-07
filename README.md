# Lookahead — know which warning to trust, and what to fix first

HackUTD 2026 · **Northmark Compute & Cloud: Keep the World Running**
*Working name. A data-center operations prototype; every facility number in the demo is simulated.*

> Data center teams run around the clock, and a missed warning, an unclear handoff, or wrong
> information at the wrong time can turn a small issue into a major outage.

Lookahead is a time-to-impact and handoff tool, not a crystal ball. It turns a facility's
dependency graph into **countdowns with ranges**, lets a technician **verify** a disputed reading
with a portable probe, **ranks** competing incidents with a visible breakdown, **dispatches** the
right person along a valid route to the right asset, and **writes the shift handoff** from the
stored record.

```
detect → verify → assess → prioritize → assign → navigate → complete → hand off
```

## Run it

```bash
npm install
npm run dev        # http://localhost:5173  ·  landing at #/, workspace at #/app
npm test           # engine tests (vitest)
npm run typecheck
npm run build
```

Routes: `#/` landing · `#/app` operations · `#/app/tasks` · `#/app/team` · `#/app/dependencies` ·
`#/app/log` · `#/app/handoff` · `#/app/field/<taskId>` technician (phone) · `#/twin-lab` 3D twin in isolation.

## Demo script (2 min)

1. **Landing → Open demo.** The hall is quiet, in grayscale.
2. **Two warnings.** A-11 reports 34.2 °C, and CRAH-2 fan vibration has tripled. The queue ranks both and shows why.
3. **Verify A-11.** Record the reference probe reading (24.1 °C) to get *measurement disagreement*. That opens a verification task; it does not dismiss the alarm. CRAH-2 is corroborated, and the action order updates.
4. **Play.** At 02:21 the make-up flow mismatch raises *possible leak*. Turn on the water layer and drag **Look ahead** forward: the wet front reaches UPS-B and BATT-B, and the clocks start. This is the Google Paris 2023 pattern, compressed.
5. **Assign.** Suggestions filter on skill, zone access and availability. Pick one; the route draws from the person's last check-in and never cuts through walls.
6. **Technician view.** Accept, walk, confirm the asset ID (the wrong ID is refused), run the checklist with probe evidence, and submit. The engineer approves, and the incident stays open until someone resolves it.
7. **Handoff.** What is happening, what is verified, what is uncertain, who owns the next action, and what not to repeat. Export it as Markdown or JSON, and acknowledge it as the incoming lead.

## What is real, what is simulated

| Piece | Status |
| --- | --- |
| Dependency graph and Monte Carlo clocks | Implemented, seeded and deterministic. Delay ranges carry their basis, and most are **assumptions**. |
| Thermal model | Lumped first-order model, **indicative, not CFD**. |
| Water layer | Height-field diffusion on a 0.5 m grid, an **approximation** whose arrival times feed graph edges. |
| Verification verdicts | Implemented rules over four explicit states. Reference readings are **labeled fixtures**. |
| Sensor ↔ app connection | **Not selected and not implemented** (handoff §15 stays blank). |
| NVIDIA Nemotron | Adapter **planned**. The *local rules* analysis runs instead and says so. |
| Persistence | Browser `localStorage` plus `BroadcastChannel`, so a second tab sees the same record. Not production storage or auth. |
| People positions | Manual or QR check-ins only, with stale positions labeled. No indoor tracking. |

## Repo map

```
src/domain/types.ts        shared contracts: one record for every view
src/domain/fixture.ts      the simulated facility DAL-1 / Hall A, scenarios, people, runbooks
src/domain/engine/         pure engine: cascade, thermal, water, verification, priority, routing, tasks, handoff
src/state/                 store (reducer + persistence + cross-tab) and selectors
src/twin/                  3D digital twin (React Three Fiber)
src/views/                 operations, inspector, tasks, team, dependencies, log, handoff, field
src/landing/               landing page
docs/                      ENGINE_CONTRACT, design-brief, research (Northmark feasibility)
tests/engine/              vitest specs mapped to acceptance criteria A01–A22
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the team workflow and [docs/ROADMAP.md](docs/ROADMAP.md) for what's next, including the 3D prediction layers.
