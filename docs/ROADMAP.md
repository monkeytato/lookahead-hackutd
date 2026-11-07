# Roadmap: from prototype to a presentable 3D prediction twin

The twin is a stack of layers, each carrying an honest fidelity label. The tiers follow the
five-tier twin from the NTU/NVIDIA work: geometric, descriptive, predictive, prescriptive,
automation. The build covers the first three tiers and part of the fourth.

| Layer | Now | Next | Fidelity label |
| --- | --- | --- | --- |
| Geometry | Hand-authored hall, UPS and battery rooms, plant, yard (`fixture.ts`) | Import a real floor plan or BIM if Northmark supplies one | Schematic |
| State | Per-asset severity, freshness and heat from readings | Live readings once a sensor connection is chosen (§15) | Measured / simulated |
| Prediction | **Look ahead** slider (+0–30 min) over seeded Monte Carlo clocks | Web Worker precompute, one frame per 30 s, and a p10/p90 envelope shown in 3D | Scenario preview with ranges |
| Water | Height-field diffusion, 0.5 m grid; arrival times become `shares_space` edges | GPU shader grid; raised-floor voids and cable trays; WebFlood or Celeris as a stretch | Approximation |
| Heat | Translucent slice at 1.2 m interpolated from rack heat | Lumped model per aisle; learned surrogate (PhysicsNeMo) on the roadmap slide only | Indicative, not CFD |
| Prescriptive | Priority breakdown, resolving check, assignment suggestions | "What if" composer: drop a fault on any asset in 3D and rerun the clocks | Engine output |

## Next build steps, in priority order

1. **Live vibration node.** ESP32 or UNO R4 with an ADXL345/355: baseline, add tape to a fan blade, and the 1× peak rises. Choose the connection first; it is deliberately unset.
2. **Nemotron adapter** (server-side): structured JSON, citations validated against stored IDs, local-rules fallback kept. Covers the NVIDIA track.
3. **Paris replay button.** Real timestamps, compressed, with a measured "how much earlier the twin flags the battery room" number labeled as a replay.
4. **Backtests for the slide:** wear-trend alarm lead time on NASA IMS or XJTU-SY bearings; thermal forecast error on held-out simulated runs.
5. **Persistence:** Express + SQLite (`node:sqlite`) or Tiger Data / MongoDB Atlas, if you take those tracks. The store's reducer actions map onto API mutations one-to-one.

## Cut list if time runs short (in order)
Heat slice → scenario preview → second sponsor track → real shallow-water solver → extra integrations → 3D polish.
Never cut the clocks, the handoff note or the live sensor reading.
