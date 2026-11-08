# Prediction science: audit, data and Nemotron design

Research-and-design dossier for the prediction side of CenterGuard (repo: Lookahead), 2026-11-07. It audits every model that produces a number, says what the literature and data support, and gives an implementation plan. **No source code was changed.** Data, derived files and scripts are in `research/`; provenance and licences are in `research/SOURCES.md`.

Markers used below: **M** = measured, **S** = simulated or calculated in the source, **V** = vendor claim, **A** = our assumption (no source found), **calc** = arithmetic done for this dossier (script in `research/scripts/`).

---

## 1. Summary

1. **The forecasts are foreknowledge, not prediction (audit C1).** `simulateScenario` runs every scripted fault, including unobserved future ones. The leak at T+4 is predicted at T+0 under "All readings normal". Everything else in this dossier is moot for the pitch until the forecast is built only from what has been observed or inferred by time *t*. Future scripted faults should enter as **hypotheses with prior probabilities**.

2. **The thermal model is not physical.** `thermal.ts` (now ΔTmax = min(30, 3·kW) °C, τ = 2 + 24/kW min; `ENGINE_CONTRACT.md` still documents the old 1.6·kW / 4 + 60/kW) is a per-rack curve fitted to the cascade's own assumed edges (circular, audit S3). After loss of airflow, the physics is a room-level energy balance. Air alone heats at P/(ρ c_p V) ≈ **8.7 °C/min** for this hall's 351 kW (calc). IT and rack thermal mass then slow it to ≈ 1 °C/min.
   - We back-tested a three-node model (room air, IT mass, chilled-water loop) against Schneider WP179.
   - With one calibrated coupling factor it reproduces the published peaks within about 0.5–3.5 °C (§2.1).

3. **Ride-through is a room and plant property, and "lost" is mis-defined.** The cascade calls a rack lost at 32 °C, which is the A1 *allowable* limit, not a failure. Servers warn or throttle at about 40–47 °C inlet (Dell iDRAC: 42 °C warning, 47 °C critical). We recommend two clocks:
   - **Out of envelope** at 32 °C.
   - **Service-impact risk** at an inlet of 40–45 °C.

   Physics Monte Carlo for the fixture hall (2,000 trials per case, calc):

   | Event | To 32 °C (p10–p90) | To 40 °C (p10–p90) |
   |---|---|---|
   | CRAH-pair fan loss | 1.5–6.7 min | 3.8–14.7 min |
   | Both chillers lost, fans running | 7–18 min | 15–33 min |

   The current chain (chiller → "pump" → CRAH → rack, modes 15 + 10 + 6 = 31 min) is too slow for 32 °C and roughly right for 40 °C.

4. **Intervals are overconfident (24 % coverage against an 80 % target).** The cause is structural: only aleatory delay noise is sampled. Parameter (epistemic) uncertainty is not: loop water volume, battery health, IT coupling, crew delay, leak rate. A two-level (hierarchical) Monte Carlo is the fix. Until coverage is near nominal, "p10–p90" should be labelled "model range" (audit S1).

5. **There are no failure probabilities anywhere.** Backup equipment never fails on demand. Real per-demand priors exist and are now in `research/derived/reliability_priors.json` (INL 2020, measured):

   | Event | Probability per demand |
   |---|---|
   | Generator fails to start | 2.2 × 10⁻³ (1.3 × 10⁻³ to 1.65 × 10⁻² across fleets; Gold Book 1.35 × 10⁻²) |
   | ATS fails to transfer | 1.3 × 10⁻³ |
   | Chiller fails to restart | 5.1 × 10⁻³ (+ 2 % in maintenance) |
   | Standby air handler fails to start | 2.1 × 10⁻⁴ (+ 0.25 % in maintenance) |

   These are rare events: 400 runs see about 0.8 generator failures. That is exactly where importance sampling, and an adversarial proposer, pays off.

6. **Sensor-vs-reference verdicts ignore the error budget (audit C3).** The workflow uses "portable ≥ 28 °C" and never compares with the installed reading. The engine's `compareReadings` uses a fixed 3 °C gap. The measured error terms are of the same order as that 3 °C gap:
   - IPMI/installed sensors can read up to 5 °C off from internal recirculation (Khalili 2019, M).
   - Counterfeit DS18B20s show offsets up to 3 °C.
   - A 1 mm path error on the 178 mm acoustic beam is about 3.4 °C.
   - Top-to-bottom cold-aisle spread is 1–5.5 °C (V).

   We recommend a Bayesian likelihood-ratio verdict: P(real condition | readings) with explicit priors. The DS18B20 needs far longer than the 10 s scan to settle; the team's own runbook says 90 s.

7. **Vibration uses the wrong standard class.** A CRAH EC fan (about 3–5 kW) is not ISO 10816-1 Class II (15–75 kW). The applicable family is AMCA 204 / ISO 14694, category BV-3 rigid: start-up 4.5, alarm 7.1, shutdown 9.0 mm/s. Under it the demo's 6.8 mm/s is "above start-up acceptance, just below alarm" and 3.2× baseline. The modelled trip 33 min later has no evidential basis; bearing degradation normally plays out over weeks. The rig's vibration channel is a qualitative switch and cannot verify mm/s at all.

8. **The water model is defensible; the leak rate and drain are not sourced.**
   - The 4 mm retained film corresponds physically to a puddle's capillary thickness, h = 2·l_c·sin(θ/2) with l_c = 2.7 mm. That gives 1.4–4.2 mm for contact angles of 30–100°, so 4 mm is the sealed-floor upper end.
   - 38 L/min matches a ~50 mm² joint gap at 3–8 bar by the orifice equation (calc). Real leaks span 1 L/min (pinhole) to hundreds of L/min (full-bore, pump-limited).
   - The drain's "30 % of depth per minute" has no source.

9. **Pitch statistic: the numbers are right, the wording needs tightening.** Uptime's 2025 Annual Survey (published in *Annual Outage Analysis 2026*, 13 May 2026) found that 57 % of respondents said their most recent major outage cost more than $100,000, and 1 in 5 more than $1 million. They are survey self-reports, not "recent major outages" in general. A lognormal fit gives a median of about $149k and a p90 of about $2.7 M (calc).

10. **Nemotron recommendation: red-team importance sampling over a physics-and-priors ensemble, plus evidence posterior and EVSI scan choice.**
    - The engine runs about 10⁴–10⁵ trials per evaluation.
    - Nemotron proposes compound "stress regions" from a closed grammar.
    - The engine samples them as a defensive mixture and re-weights every trial by p/q.
    - Estimates stay unbiased whatever Nemotron proposes, and Nemotron still never produces a reported number.
    - Details in §5; implementation in §6.

---

## 2. Model-by-model findings

Each subsection gives the current model, what the evidence says, and what to do instead.

### 2.1 Thermal rise after cooling loss (`src/domain/engine/thermal.ts`, cooling edges in `fixture.ts`)

**Current.** T(t) = base + ΔTmax·(1 − e^(−(t − t_lost)/τ)), with ΔTmax = min(30, 3·kW) °C and τ = 2 + 24/kW min, per rack. It is "calibrated" so that a 6 kW rack crosses 32 °C near the cascade's 6-minute mode. The cascade edges themselves are assumptions, so the calibration is circular.

How the current curve behaves (calc, base 22 °C):

| Rack kW | Asymptote | to 32 °C | to 35 °C | to 40 °C |
|---|---|---|---|---|
| 6 | 40 °C | 4.9 min | 7.7 min | never |
| 8 | 46 °C | 2.7 min | 4.0 min | 7.0 min |
| 10 | 52 °C | 1.8 min | 2.5 min | 4.1 min |
| 31 (liquid) | 52 °C | 1.2 min | 1.6 min | 2.6 min |

Two problems:
- A rack does not have its own asymptote. Its inlet air is room or aisle air, and the hall keeps heating as long as IT runs on UPS.
- The liquid-cooled GPU racks are driven by CDU flow, not by air.

**Physics.** The room-level energy balance used by WP179 and the Schneider patents US9418179B2 / US10817033 has three lumped nodes:

```
C_a · dT_a/dt = P_air − Q_coil(t) − G·(T_a − T_m)     room air, well mixed (≈ rack inlet)
C_m · dT_m/dt = G·(T_a − T_m)                         IT + rack steel
C_w · dT_w/dt = Q_coil(t) − Q_chiller(t)              chilled-water loop (pipes, coils, any tank)

C_a = ρ_air·c_p·V            ρ = 1.19 kg/m³, c_p = 1006 J/kg·K
C_m = N_racks · m_rack · c_m  m_rack ≈ 545 kg (WP179), c_m ≈ 650 J/kg·K (US10817033)
G   = k_G · ε · ṁ_IT · c_p    ε = 0.7–0.9 (US10817033), ṁ_IT from ~125 cfm/kW (WP179) = 0.059 m³/s per kW
Q_coil = fans on ? ṁ_crah·c_p·(T_a − T_s) : 0,   T_s = max(T_set, T_a − ε_coil·(T_a − T_w))
Q_chiller = chiller on ? min(ramp(t)·Q_cap, Q_coil + C_w·(T_w − T_w,set)/60 s) : 0
```

How it behaves:
- **Initial slope with fans off:** dT/dt = P/C_a. For the hall (24 × 24 × 3.5 m = 2016 m³, C_a = 2.41 MJ/K, 351 kW air-cooled IT) that is 0.146 K/s = **8.7 °C/min**. WP179 says "5 °C/minute … or more" (S).
- **Long-run slope:** P/(C_a + C_m). With 44 racks × 545 kg × 650 J/kg·K = 15.6 MJ/K, that is about 1.2 °C/min.
- **Mass lag:** air leads the mass by a quasi-steady offset of about P/G. This offset, not the rack kW, decides how fast 32 °C is reached.
- **Server thermal mass, measured:** a 2U server is 11.1 kJ/K (±7 %) with an airflow of 0.066 kg/s (Ibrahim 2013). That gives a server time constant of C/(ε·ṁ·c_p) ≈ 3.5 min, matching "several minutes".

**Backtest** (`research/scripts/thermal_backtest.mjs`; targets in `research/data/published-transients/cooling_outage_points.csv`). Setup:
- **WP179 Example 1:** 400 kW; room 30 × 24 × 4 m plus a 0.6 m plenum; 100 racks of 545 kg; generator at 60 s; chiller restart at 12 min.
- **Fitted:** one unknown, the loop water volume, to the 41.1 °C baseline peak.
- **Predicted:** the 5-min and 4-min restart peaks, the recovery time, and the CFD-room curve.
- **k_G** multiplies the nominal IT-air coupling. It stands in for server fans ramping up and for other mass (tiles, cabling, walls).

| Target (published, S) | k_G = 1 | k_G = 1.5 | **k_G = 2** | k_G = 3 |
|---|---|---|---|---|
| Ex. 1 baseline peak 41.1 °C (fitted) | 41.1–41.7 | 40.5–41.0 | 40.8–41.1 | 38.6–38.8 |
| Ex. 1, 5-min restart: 36.7 °C | 32.6–33.6 | 33.4–35.0 | **35.9–36.5** | 34.2–34.6 |
| Ex. 1, 4-min restart: ≈ 32.2 °C | 32.6 | 32.2–33.8 | 34.7–35.6 | 33.3–33.9 |
| Ex. 1, back below 32 °C at ≈ 17 min | 20.8–25.3 | 19.2–23.9 | 18.2–26.4 | 20.2–30.2 |
| CFD room 34.7 °C at 60 s | 35.2 | 34.6 | **34.0** | 33.1 |
| CFD room 37.3 °C at 300 s | 45.6 | 41.5 | **39.1** | 36.6 |

Ranges are for an instant chiller restart vs a 4-min capacity ramp. For the CFD room, IT load was inferred from the 0–30 s slope (59 kW) and 15 racks were assumed, because the source's load figure is illegible. That makes the CFD rows a consistency check, not an independent validation.

**Reading the backtest:**
- With k_G = 1 (textbook coupling) the late rise is badly over-predicted: +8 °C at 5 min.
- k_G ≈ 2 (range 1.5–3) fits both WP179 cases within about 0.5–3.5 °C. The 4-min case is over-predicted by about 3 °C.
- A one-node water loop cannot reproduce how fast a restart recovers (see the 4- vs 5-min rows).
- With k_G ≥ 2 the fitted loop volume collapses to the grid floor, so loop volume is **not identifiable** from WP179. Sample it from engineering practice instead (§3).

**Density sweep, fans off, well mixed, 2 m² floor per rack, 22 °C start** (seconds; k_G = 1 / k_G = 2):

| kW/rack | to 32 °C | to 35 °C | to 40 °C | to 45 °C |
|---|---|---|---|---|
| 2.5 | 60 / 240 | 95 / 675 | 250 / 1405 | 910 / — |
| 5 | 30 / 120 | 50 / 340 | 125 / 705 | 455 / 1065 |
| 8 | 20 / 75 | 30 / 215 | 80 / 440 | 285 / 670 |
| 10 | 15 / 60 | 25 / 170 | 65 / 355 | 230 / 535 |
| 20 | 10 / 30 | 15 / 85 | 35 / 180 | 115 / 270 |

Published comparisons:
- **Opengate 2007:** thermal shutdown at 5 kW/cabinet in 189 s, under 60 s at ≥ 10 kW. Press-only, vendor-commissioned.
- **Khankari:** 5 kW reaches 35 °C in 25–45 s and 46 °C in 80–125 s. This is per-cabinet CFD with local recirculation, so it is faster than well-mixed.

So well-mixed is the **slow** bound and Khankari-style local recirculation is the **fast** bound. The rack-level inlet sits between, depending on containment.

**Chiller loss with fans still running** (CRAHs and pumps on the generator bus, chillers gone) is a much slower process, governed by loop water:
- **Tradat et al. 2018 (M):** 74 kW in a 215 m² lab with the CRAH blower on reached 32 °C in 22–46 min and 35 °C in 30–52 min, external sensor vs IPMI.
- **IPMI sensors** under-estimated ride-through by 12–42 % (IPMI read hot).

**Fixture hall Monte Carlo** (`thermal_backtest.mjs`, 2,000 trials). Parameters sampled:
- ceiling 3.0–4.5 m
- plenum 0 or 0.6 m
- ε 0.6–0.9
- rack mass 350–700 kg
- start temperature 20–25 °C
- loop water 3–11 L/kW, log-uniform (A)
- 0–50 % air mixing from the running half

| Event | Threshold | k_G = 1 p10 / p50 / p90 (min) | k_G = 2 | k_G = 3 |
|---|---|---|---|---|
| CRAH-1 + CRAH-3 fans off (rows A/B, 190 kW) | 32 °C | 1.5 / 2.0 / 2.8 | 2.0 / 3.2 / 4.8 | 2.8 / 4.5 / 6.7 |
| | 40 °C | 3.8 / 5.3 / 7.2 | 7.3 / 9.5 / 12.5 | 8.8 / 11.5 / 14.7 |
| CH-1 + CH-2 lost, fans on (hall, 370 kW to air) | 32 °C | 7.0 / 10.0 / 14.2 | 9.0 / 12.5 / 17.0 | 10.0 / 13.7 / 18.2 |
| | 40 °C | 14.7 / 20.3 / 28.0 | 18.2 / 23.7 / 31.3 | 19.3 / 24.8 / 32.5 |

**Recommended:**
1. Replace per-rack `inletTempAt` with a zone model. Use one zone per CRAH pair (north A/B, south C/D), coupled to a hall chilled-water node. The three nodes above, integrated at dt = 1 s, cost about 20 µs per parameter set.
2. Feed its threshold-crossing times into the cascade as the **delays of the cooling edges**: the per-trial delay comes from physics, not a triangle.
3. Collapse the chiller → "pump" → CRAH chain. A pump does not "fail" when chillers trip; the water warms. Keep pumps as nodes only for pump failures.
4. Define rack **service impact** at T_inlet ≥ T_trip with T_trip ~ U(40, 45) °C (A). Anchors: the A3 limit of 40 °C, the A4 limit of 45 °C, and iDRAC 42/47 °C. Report the **32 °C envelope crossing** as a separate, earlier clock.
5. **GPU / direct-liquid-cooled racks:** when CDU flow stops, the time to CPU throttle was measured at 23–34 s at full load and 305–353 s idle (Alkharabsheh 2017, M). At 31/40 kW use Triangular(0.3, 0.6, 2.0) min to throttle. Losing one of two pumps (−32 % flow) had **no** effect. This node is "throttled", not "lost".
6. **Chiller restart after a fix:** ramp capacity over the restart time.
   - Standard chiller: 10–15 min (WP179).
   - Quick-start: 2.5–5 min (Trane: compressor at about 64 s, 80 % at about 160 s; Daikin: under 43 s to restart; vendor claims).
   - The inlet then **lags** recovery by several minutes; WP179 stays hot until about 5 min after the 12-min restart. A fix therefore does not make a rack "safe at effectiveAt".
7. Use **k_G ~ U(1.5, 3)** as an epistemic parameter, until site data replace it.

### 2.2 Cascade delays and redundancy (`cascade.ts`, edges in `fixture.ts`)

**Current model.** Each edge delay is drawn from a triangular {min, mode, max}, 400 runs, seed 7. Redundancy is AND within a group and MIN across groups. Fixes recover nodes. The algorithm is sound and fast: about 36 µs per run on this graph (`research/scripts/bench_engine.ts`: 400 runs take 14 ms; the water layer adds about 60 ms per scenario).

What the model lacks:
1. **Failures on demand.** Every backup works.
2. **Parameter uncertainty.** A per-iteration bias exists only in the validation harness, never in the predicting model.
3. **Correlation between edges.** All 44 rack thermal edges are independent draws. In reality they share one room, so they are strongly correlated.

| Edge (fixture) | Current {min, mode, max} min | Evidence | Recommended |
|---|---|---|---|
| GEN-1 → ATS-1 | 0, 0.2, 0.5 | NFPA 110 Type 10 requires power within 10 s. WP179 assumes 60 s. WP75 models 190 s. | Triangular(0.15, 0.5, 3.2) min. Also **Bernoulli fail-to-start**: Beta(136.5, 61227.5), mean 2.2e-3 (INL EDG-FTS, M). Sensitivity range: 1.35e-2 (Gold Book via WP75) and 1.65e-2 (poorly maintained, NREL). |
| ATS-1 transfer | implicit, always works | INL ABT-FF 1.33e-3 per demand (M) | Bernoulli fail-to-transfer 1.33e-3 |
| ATS-1 → BATT-A / BATT-B (autonomy) | 8, 12, 18 / 6, 10, 15 | Replace at 80 % of rated capacity (IEEE 450/1188 practice, secondary). No citable runtime distribution for aged strings. WP75 uses 7 min at full load. | autonomy = T_vendor(load fraction) × SoH. String A: SoH ~ U(0.9, 1.0). String B (11 years on a 10-year life): SoH ~ U(0.6, 0.85) (A). Keep the current ranges as T_vendor until a vendor curve is entered. UPS drops load on transfer: 1e-3 (WP75, V). |
| UPS → PDU, PDU → rack | 0 | ok | Breaker spurious opening 1.7e-7/h. Negligible inside 60 min; keep it for random scenarios. |
| CH → P (chilled water) | 8, 15, 25 | Physics (§2.1): the loop warms, the pump does not fail | **remove**; replace with the zone ODE |
| P → CRAH/CDU (coil) | 5, 10, 20 | same | **remove**; keep a pump node only for pump-failure scenarios |
| CRAH pair → rack | 3, 6, 10 | Physics MC: 32 °C at p10 1.5 / p90 6.7 min; 40 °C at 3.8–14.7 min (k_G 1–3) | Per-trial delay from the ODE, with one shared draw per zone (correlated) |
| CDU-1 → GPU racks | 1, 2, 4 | 23–353 s to CPU throttle, measured (Alkharabsheh 2017) | Triangular(0.3, 0.6, 2.0) min to **throttle**, not loss |
| UPS-A/B → CDU-1 | 0 | The authors recommend CDU pumps on UPS. A dual feed is common practice (A). | ok |
| PIPE-L2 → BATT-B (candidate) | 20, 45, 90 | Google europe-west9: alert 45 min after the leak began; battery/UPS-room involvement known about 3 h 22 min after (incident report) | Use the water model with a leak-rate prior (§2.3). Keep the candidate edge for the dependency-discovery story. |
| Standby CRAH (`swap_crah` fix) | always starts | INL AHU-FTS-NS 2.11e-4, plus 2.5e-3 test/maintenance unavailability | Bernoulli fail 2.7e-3 |
| Chiller restart (`restart_chiller`) | always works after 7 min | INL CHL-FTS-NR 5.09e-3, plus 2 % unavailable. Restart takes 10–15 min standard, 2.5–5 min quick-start. | Bernoulli 5e-3. Time = walk (route ETA) + reset LogNormal(median 3, EF 2) min + restart ramp. |

**Redundancy.** Treating a CRAH pair as AND-redundant is right in principle, but N+1 only holds if one unit can carry the whole zone. Add a per-zone capacity check. With one CRAH left, if Q_cap,1 < P_zone, the zone heats slowly instead of not at all. The ODE handles this once Q_coil is capped at unit capacity.

### 2.3 Leak spread (`water.ts`)

**Current model.** Height-field diffusion on 0.5 m cells, 12 substeps per minute, 4 mm retained film, 5 cm plinths, and drains that remove 30 % of local depth per minute. The leak rate is 38 L/min (fixture).

**Puddle thickness.** A large puddle on a flat floor stops spreading at h = 2·l_c·sin(θ/2), where l_c = √(γ/ρg) = √(0.072/(1000·9.81)) = 2.7 mm is the capillary length (de Gennes et al. 2004).

| Floor | Contact angle θ | Puddle thickness h |
|---|---|---|
| Bare or sealed concrete | 30–60° | 1.4–2.7 mm |
| Epoxy or vinyl | 70–100° | 3.1–4.2 mm |

- `retainMm = 4` is physically grounded for a sealed or vinyl floor.
- On a wetting concrete floor the front covers 1.5–3× more area per litre and arrives sooner.
- Recommended: retainMm ~ U(1.5, 4.0) per zone's floor finish (A for θ).

**Area-rate check.** At 38 L/min and h = 4 mm the wetted area grows at 9.5 m²/min. That is consistent with the fixture's tuned arrivals and with a volume-limited front.

**Leak rate.** Orifice equation Q = C_d·A·√(2ΔP/ρ) with C_d = 0.61 (calc):

| Opening | 3 bar | 5 bar | 8 bar |
|---|---|---|---|
| 1 mm pinhole | 0.7 L/min | 0.9 L/min | 1.1 L/min |
| 1/8 in hole | 7.1 L/min | 9.2 L/min | 11.6 L/min |
| 0.5 × 20 mm crack | 9.0 L/min | 11.6 L/min | 14.6 L/min |
| 50 mm² joint gap | 45 L/min | 58 L/min | 73 L/min |
| DN25 full bore (upper bound; pump-limited) | 440 L/min | 568 L/min | 719 L/min |

- A utility leak table gives a 1/8 in hole at 60 psi = 3,806 gal/day ≈ 10 L/min, which agrees (C_d ≈ 0.73).
- The often-quoted "1/8 in crack = 250 gal/day" is insurance marketing and about 15× too low. Do not use it.

**Recommended leak-rate prior.** A mixture over failure modes; the weights are A, the rates come from physics:

| Failure mode | Weight | Rate |
|---|---|---|
| Pinhole or weep | 0.35 | LogN(median 1 L/min) |
| Crack | 0.35 | LogN(10) |
| Joint or gasket | 0.25 | LogN(50) |
| Major break | 0.05 | LogN(300), capped by the pump |

The scenario's make-up-water mismatch (+38 L/min) is evidence. Condition on it (§2.6): the posterior then concentrates on the observed value, with the flow meter's error.

**Leak frequency.** For random scenarios: a manual valve develops a small external leak at 8.7e-8/h and ruptures at 6.1e-9/h (INL, M). No pipe-run rates were found.

**Drain.** "30 %/min of depth" has no source. Replace it with a capacity in L/min ~ U(20, 150) (A), plus a Bernoulli 0.2 that the drain is blocked or covered (A).

**Detection.** Rope and cable leak sensors respond in 1–30 s, all vendor claims: RLE LD310 "<20 s, 10 s typical", Kidde 1–2 s, Infrasensing about 30 s. The fixture correctly has no sensor on Level 2.

**Not a fluid solver.** The model has no momentum and no raised-floor plenum flow. Pooling against door thresholds is represented only through zone elevations. Keep the "approximation" label in the UI.

### 2.4 Vibration thresholds (`fixture.ts`; the workflow demo uses 6.8 mm/s)

**Current.** Warn at 2.8 and alarm at 7.1 mm/s, labelled "ISO 10816-1 class II (15–75 kW)".

**Evidence.**
- A CRAH EC plenum fan is about 3–5 kW.
- Under ISO 10816-1 that makes it **Class I**, with zone boundaries 0.71 / 1.8 / 4.5 mm/s. 6.8 mm/s is then zone D.
- ISO 10816-3 / 20816-3 applies only above 15 kW.
- The right family is **AMCA 204-20 / ISO 14694**. HVAC above 3.7 kW is category **BV-3**. In-situ limits (rms, 10–1000 Hz, at the bearing housings):

| Category | Start-up | Alarm | Shutdown |
|---|---|---|---|
| BV-3 rigid | 4.5 mm/s | 7.1 mm/s | 9.0 mm/s |
| BV-3 flexible | 6.3 mm/s | 11.8 mm/s | 12.5 mm/s |

- AMCA: "a sudden increase in vibration velocity level may indicate the need for prompt inspection."
- Vendor rules of thumb: 2–3× baseline for caution, 4–6× for alarm (V, unverified).

**Recommended.**
1. Thresholds `{ warn: 4.5, alarm: 7.1, trip: 9.0 }`, basis "AMCA 204-20 BV-3 rigid (CRAH fan > 3.7 kW)".
2. A change rule: ≥ 2× baseline = caution, ≥ 4× = alarm (A).
3. 6.8 mm/s then reads as caution plus a 3.2× change from baseline. The demo story ("rising, inspect before it trips") becomes correct.
4. **Time to trip.** The scripted trip at T+34 has no evidential basis. Vibration-detectable bearing degradation usually develops over weeks to months. We found no citable P-F interval data, so this is a range claim (A). Present the trip as a what-if hypothesis with a probability, not as a clock.
5. **The rig measures no mm/s.** `vibrating` is a digital switch, so a vibration "confirmed" verdict can only mean "motion present". Cap the verdict at "corroborates presence"; it says nothing about severity or zone.

### 2.5 Fix effects (`fixes.ts`)

**Current.** Each fix has a fixed delay; the fix "repairs the asset from effectiveAt"; the counterfactual compares p50 lost against not lost.

| Fix | Delay (min) |
|---|---|
| Isolate valve | 4 |
| Chiller restart | 7 |
| Fan reset | 5 |
| Standby CRAH | 10 |
| Generator start | 5 |
| UPS transfer | 3 |
| Suppression | 2 |
| Breaker | 4 |
| Shed load | 3 |
| Portable cooling | 12 |

**Evidence.**
- **Chiller restart:** 10–15 min for a standard chiller, 2.5–5 min for quick-start, plus walk and reset time. The current 7 min therefore assumes a quick-start unit.
- **Standby failures:** standby units fail to start about 0.3 % of the time, chillers about 0.5 %, plus maintenance unavailability.
- **Response times:** no published data-center response times were found.
  - The THERP curve gives P(fail to diagnose) = 0.1 at 10 min and 0.01 at 20 min (NUREG/CR-1278, secondary).
  - The Paris incident took 45 min from leak to alert.
- **Validation:** predicted saved averages 32.1 racks against 23.6 realised, an overstatement of about 36 %, because fix time and success are deterministic.

**Recommended.**
1. Fix delay = route ETA (`routing.ts` exists) + task time LogNormal(median = current value, error factor 2) (A) + Bernoulli fail-on-demand (§3).
2. Model thermal fixes physically:
   - A chiller restart ramps up Q_chiller.
   - Shed load reduces P; it buys time rather than repairing anything.
   - Portable cooling adds Q, about 3–10 kW per unit (A).
3. Report each fix as a distribution: P(rack saved), E[racks saved], and p10–p90.
4. Fix the cache key (audit C12): hash the faults, leak, hazards and evidence, not just the scenario id.

### 2.6 Sensor-vs-reference disagreement (`verification.ts`, `workflowHub.ts` `verify_scan`, `rig/scan.ts`)

**Current.**
- The workflow says "confirmed" when the portable mean is ≥ 28 °C (or > 0.5 for wet or vibration), else "disagrees". The installed value is never compared (audit C3).
- `compareReadings` (a 3 °C or 30 % gap) is unused.
- The rig flags acoustic vs DS18B20 disagreement above 2 °C.
- The simulated rig always reads normal (audit C4).

**Error budget (1σ unless stated):**

| Term | Value | Source |
|---|---|---|
| Installed RTD, class A/B at 25 °C | ±0.20 / ±0.43 °C tolerance | IEC 60751 |
| Installed NTC drift | epoxy about 0.2 °C/yr, glass about 0.02 °C/yr | Ametherm via DigiKey (V) |
| Installed IPMI/server inlet bias | up to +5 °C from recirculation; within 0.5 °C without | Khalili 2019 (M) |
| HVAC sensor fault prevalence | ≥ 20 % of air-terminal units with discharge-air temperature-sensor faults | Sci. Tech. Built Env. 2023 (M, abstract) |
| DS18B20, genuine | ±0.5 °C (3σ); measured −0.1 to +0.2 °C at 0 °C | datasheet; Petrich (M) |
| DS18B20, counterfeit | offsets from −3.5 to +3 °C in some families | Petrich (M) |
| SHT3x (upgrade option) | ±0.2 °C typical, < 0.03 °C/yr drift | Sensirion (V) |
| HC-SR04 acoustic, 178 mm path | 1 µs ≈ 1.16 °C one-way; **1 mm of path error ≈ 3.4 °C**; 0→100 % RH ≈ +2.2 °C if uncorrected | calc; Rane note |
| Cold-aisle vertical spread | contained ≤ 1.1 °C; uncontained ≥ 5.5 °C | Subzero (V) |
| Probe settling | runbook says 90 s; the scan holds only 10 s (5 s minimum) | `fixture.ts` RB-VERIFY-TEMP; `rig/protocol.ts` |

**Consequences.**
1. **The fixed 3 °C gap is not a consistent test.**
   - Inputs: σ_inst 0.5–1.5, σ_ref 0.17–1.0, σ_spatial 0.3–2.0.
   - Result: σ_diff ≈ 0.6–2.7 °C, so a 3 °C gap is anywhere from 1σ to 4σ.
   - Use a likelihood ratio instead of a threshold.
2. **After `cal`, the acoustic beams are not independent.** `cal` derives the beam paths from the DS18B20, so they inherit its error. Count them as one reference that also carries top/bottom information.
3. **A 10 s hold does not let a carried DS18B20 settle.**
   - Step-test its time constant.
   - Until then, extrapolate a first-order fit to the asymptote, or flag `unsettled_lag` when |slope| > 0.2 °C/min.
   - Do not rely on sd > 0.5 °C, which catches noise but not lag.

**Recommended verdict: a Bayesian posterior** (new `evidence.ts`; all numbers are engine output):

```
Hypotheses: H_real (the reported condition is real at the point)
            H_meas (the installed reading is a measurement problem: offset, drift, placement, recirculation)
p(y | H_real) = StudentT_ν=4( y ; x , √(σ_inst² + σ_ref² + σ_sp²) )
p(y | H_meas) = StudentT_ν=4( y ; μ_model(t), √(σ_model² + σ_ref² + σ_sp²) )
  μ_model(t) = engine baseline inlet for that rack WITHOUT the alleged condition
              (zone ODE, or neighbours' installed readings), σ_model ≈ 1–1.5 °C
Slope term: under a cooling-loss H_real the zone ODE predicts dT/dt; compare it with the reference slope.
P(H_real | data) = LR·π / (LR·π + 1 − π)
```

**Worked example.** Parameters: σ_inst 1, σ_ref 0.3, σ_sp 1.5, μ_model 23.5, σ_model 1.5; Gaussian for brevity.
- Installed 34.2 °C, reference 24.0 °C: LR ≈ 10⁻⁶. The readings strongly favour a measurement problem.
- Reference 31.0 °C instead: LR ≈ 110 in favour of a real condition.
- Student-t (ν = 4) keeps one counterfeit probe from producing absurd certainty.

**Prior π.** No published base rate was found. Default π = 0.5 (A) and show the sensitivity at 0.2 and 0.8.

**Wording.** Keep acceptance A04, for example: "Readings favour a measurement problem at the installed sensor (P ≈ 0.98 under the stated error assumptions); this does not prove the sensor is faulty."

**Mapping to verdicts:**

| Condition | Verdict |
|---|---|
| P(real) ≥ 0.9 | `corroborated_abnormal` |
| P(real) ≤ 0.1 | `measurement_disagreement` |
| Otherwise | `inconclusive` |
| The probe cannot physically measure the quantity (air probe on chiller supply water, audit C3) | `inconclusive`, with "not measurable by the portable rig" |

**Water.** Same structure with binary data, using detector sensitivity and specificity (A: 0.95 / 0.98).
- The water model predicts wet or dry at each scan point and time under each leak-rate bin.
- That gives a likelihood over the leak rate: data assimilation that re-weights the ensemble.

### 2.7 Percentiles and intervals (`cascade.ts` `pct`, validation harness)

**Current.**
- Empirical quantiles over 400 runs, with ∞ meaning "not lost". This is fine: the standard error of a 10 % tail at n = 400 is ±1.5 percentage points.
- p10–p90 covers 24 % of realised losses against an 80 % target. Chiller is 4 %, ATS 5 %, OVH 0 %.

**Causes.**
1. **No epistemic sampling.** The harness's "reality" applies a ±20 % per-iteration bias; the model applies none.
2. **Independent draws for physically shared quantities.** These average out and look certain.
3. **Binary "lost by p50" outcomes.** These produce the 48/48 cliffs (audit S2).

The harness is a robustness check against a perturbed copy of the model, not empirical validation.

**Recommended.**
1. Run a **hierarchical Monte Carlo**:
   - Outer loop: θ drawn from the priors in §3.
   - Inner loop: aleatory delays.
   - Share one draw per physical quantity: zone ride-through, battery health, crew speed.
2. Report distributions:
   - P(service impact) per rack, row and service.
   - Racks impacted at p10/p50/p90.
   - Time to first impact.
3. Label the interval "model range (coverage under test: X %)" until the harness shows 75–85 % (audit S1).
4. Use importance sampling for rare events (§5), not more brute-force runs.

### 2.8 Ambient and chiller capacity (DFW weather)

**Data.** Ten years of Open-Meteo hourly data plus three years of the NOAA DFW station; summary in `research/derived/dfw_weather_summary.json`.
- Daily-max bias, reanalysis minus station: −0.2 °C.
- 90 % of days fall within −2.6 to +2.5 °C (970 days).

| Year | T_max °C | 99.6 % dry-bulb | Hours ≥ 35 °C | Hours ≥ 40 °C | Wet-bulb max | 99.6 % wet-bulb |
|---|---|---|---|---|---|---|
| 2018 | 42.9 | 39.8 | 338 | 33 | 27.7 | 26.1 |
| 2020 | 40.9 | 38.5 | 208 | 9 | 27.2 | 26.4 |
| 2022 | 43.0 | 40.1 | 571 | 45 | 27.5 | 25.8 |
| **2023** | **43.3** | **41.6** | **647** | **136** (station: 124) | 29.1 | 27.4 |
| 2024 | 41.7 | 38.5 | 326 | 9 | 27.4 | 26.3 |
| 2025 | 40.7 | 38.1 | 289 | 6 | 26.2 | 25.6 |
| 2016, 2017, 2019, 2021 | 38.1–38.5 | 35.7–37.2 | 74–218 | 0 | 26.9–28.3 | 26.1–26.7 |

February 2021 (Winter Storm Uri) had 50 h at or below −10 °C, with a minimum of −17.8 °C. That is relevant to generator fuel gelling, which is not modelled.

**Chiller derate.** Air-cooled chillers are rated at 35 °C and derate above it.
- Condensing temperature rises about 1:1 with ambient (patent US5806327).
- **No manufacturer per-°C table was found.** Use a derate d ~ U(1.0, 2.0) %/°C (A) until the selection-software curve for the actual model is available.

| Year | Hours below 90 % capacity, d = 1.5 %/°C | Hours below 90 % capacity, d = 2 %/°C |
|---|---|---|
| 2022 | 14 h | 39 h |
| 2023 | 35 h | 130 h |
| 2024 | 2 h | 9 h |
| 2025 | 0 h | 6 h |

At the 43.3 °C peak, capacity is 83–92 %.

This hardly matters at night for N+1 chillers; the fixture's scenarios start at 02:10. For the heat-wave scenario:
- Sample ambient from the DFW month × hour distribution.
- Cap Q_cap with the derate.

High-ambient head-pressure trips happened in London in July 2022 at about 40 °C, but no hazard curve P(trip | ambient) was found. Keep those trips scripted and label them as what-if hypotheses.

### 2.9 Cost at risk (Uptime Institute)

**Verified figures.**

| Edition (survey year) | > $100k | > $1M | Source |
|---|---|---|---|
| *AOA 2026* (2025 survey), released 13 May 2026 | 57 % | 1 in 5 | "In Uptime's 2025 Annual Survey, 57% of respondents said their most recent major outage cost more than $100,000. For the second consecutive year, 1 in 5 reported costs exceeding $1 million." |
| *AOA 2025* (2024 survey) | 54 % | 1 in 5 | |
| *AOA 2024* | 54 % | 16 % | |
| 2022 release | over 60 % | 15 % | |

**Pitch fix.** Replace the current line with:

> "In Uptime Institute's 2025 annual survey, 57% of operators said their most recent major outage cost more than $100,000, and 1 in 5 said it cost more than $1 million (Uptime Institute, Annual Outage Analysis 2026)."

**Lognormal fits** to the two exceedance points (calc):

| Survey | σ_ln | Median | p10 | p90 | Mean |
|---|---|---|---|---|---|
| 2025 survey | 2.26 | $149k | $8k | $2.7M | $1.9M |
| 2024 survey | 2.44 | $128k | $6k | $2.9M | $2.5M |

**How to use them.**
- These are cross-organisation self-reports of *major* outages, not this facility's cost per rack.
- Show them as context next to P(service impact). Example: "if this becomes a major outage, industry experience puts the cost at a median of about $150k, with a 1-in-5 chance above $1M."
- Never multiply them into one "expected $" headline: the mean is tail-dominated and sensitive to the fit.

---

## 3. Parameter table

These are the priors the ensemble samples. "A" means no source was found, so the value is our assumption and the range is deliberately wide. Machine-readable copies of the reliability rows are in `research/derived/reliability_priors.json`.

| Parameter | Recommended value / distribution | Units | Source |
|---|---|---|---|
| Air density × c_p | 1.19 × 1006 | J/m³·K | standard properties |
| Hall air volume | 24 × 24 × U(3.0, 4.5) m, + 0.6 m plenum with p = 0.5 (A: fixture has no ceiling or raised-floor data) | m³ | A |
| Rack mass (incl. IT) | U(350, 700); WP179 uses 545 | kg | WP179 https://ecl-ips.com/wp-content/uploads/2014/01/apc-data-centre-temperature-rise-during-a-cooling-system-outage.pdf |
| IT specific heat | 650 | J/kg·K | US10817033 https://patents.google.com/patent/US10817033 |
| Server thermal mass (2U, check) | 11.1 ± 7 % | kJ/K | Ibrahim 2013 https://www.electronics-cooling.com/2013/12/characterization-server-thermal-mass/ |
| IT airflow | 125 cfm/kW (0.059 m³/s per kW) | — | WP179 |
| IT heat-exchange effectiveness ε | U(0.6, 0.9) | — | US10817033 (0.7–0.9) |
| Coupling multiplier k_G | U(1.5, 3); fitted to WP179 | — | this dossier §2.1 (calc) |
| Chilled-water loop volume | log-uniform 3–11 L/kW (A; 3–10 gal/ton chiller-stability practice, not verified); not identifiable from WP179 | L/kW | A |
| CRAH airflow (zone) | 1.2 × IT airflow (A) | m³/s | A |
| Air-cooled GPU share | 0.15 of DLC rack power to air (A) | — | A |
| Rack service-impact threshold | T_trip ~ U(40, 45) | °C inlet | ASHRAE A3/A4 https://www.ashrae.org/file%20library/technical%20resources/bookstore/supplemental%20files/therm-gdlns-5th-r-e-refcard.pdf; iDRAC 42/47 https://www.manualslib.com/manual/1244291/Dell-Idrac-8.html?page=105 |
| Envelope thresholds | recommended 18–27; A1 allowable 15–32; A2 10–35; A3 5–40; A4 5–45; H1 allowable 15–25 °C; ≤ 5 °C per 15 min, ≤ 20 °C/h | °C | ASHRAE TC9.9 5th ed. reference card (URL above) |
| DLC CPU throttle after pump stop | Triangular(0.3, 0.6, 2.0) at 78 % load; measured 23–34 s full, 305–353 s idle | min | Alkharabsheh 2017 https://par.nsf.gov/servlets/purl/10058025 |
| Generator start-to-transfer | Triangular(0.15, 0.5, 3.2) | min | NFPA 110 via https://achrnews.com/articles/158160-standby-power-behind-the-10-second-start; WP179; WP75 https://content.voltimum.com/br/1537/scb_02_ups_system_wp75r4.pdf |
| Generator fail to start | Beta(136.5, 61227.5), mean 2.2e-3; sensitivity 1.35e-2 / 1.65e-2 | per demand | INL/EXT-21-65055 https://www.osti.gov/servlets/purl/1847110; NREL https://www.osti.gov/servlets/purl/1659849 |
| Generator fail to load/run (first hour) | 3.31e-3 | per hour | INL |
| ATS fail to transfer | Beta(4.5, 3373.5), mean 1.33e-3 | per demand | INL |
| UPS drops load on transfer to battery | 1e-3 | per demand | WP75 (V) |
| Battery state of health | string A U(0.9, 1.0); string B U(0.6, 0.85) (A); end of life defined as 0.8 | fraction | IEEE 450/1188 practice via https://open-exam-prep.com/study-guides/neta-ett-level-ii/grounding-batteries-devices/battery-load-test-ieee-450-vrla |
| Battery autonomy at load | T_vendor(load) × SoH; keep the fixture ranges as T_vendor until a curve exists | min | A |
| Standby CRAH fail to start | 2.11e-4 + 2.5e-3 unavailable | per demand | INL AHU-FTS-NS |
| Chiller fail to restart | Beta(66.5, 21071.5), mean 5.09e-3; + 2.0e-2 unavailable | per demand | INL CHL-FTS-NR |
| Chiller restart to full capacity | standard U(10, 15); quick-start U(2.5, 5) | min | WP179; Trane https://elibrary.tranetechnologies.com/public/commercial-hvac/Literature/Sales/AC-SLB003-EN_10302024.pdf; Daikin https://www.daikinapplied.com/news/blogs/RapidRestore (V) |
| Chiller fail to run (normally running) | 3.87e-5 | per hour | INL |
| Pump fail to start / run | 5.88e-4 per demand / 2.26e-6 per hour | — | INL |
| Chiller derate above 35 °C | U(1.0, 2.0) (A, unverified) | % per °C | A; rating basis 35 °C from manufacturer manuals |
| DFW ambient | empirical month × hour distribution, 2016–2025 | °C | Open-Meteo / NOAA (§4) |
| Leak rate | mixture: 0.35 LogN(1), 0.35 LogN(10), 0.25 LogN(50), 0.05 LogN(300), σ_ln 0.5 each (A weights) | L/min | orifice physics (calc); https://www.assumptionparishwaterworks.com/documents/1616/Simply_Leak_Detection.pdf |
| Retained film (puddle depth) | U(1.5, 4.0) by floor finish | mm | capillary length, de Gennes et al. 2004 (calc) |
| Drain capacity | U(20, 150) L/min, p(blocked) = 0.2 (A) | L/min | A |
| Leak-sensor response | 1–30 | s | RLE https://assets.kele.com/Catalog/11%20Level/PDFs/LD310%20Series%20Catalog%20Page.pdf; Kidde (V) |
| CRAH fan vibration limits | BV-3 rigid 4.5 / 7.1 / 9.0; flexible 6.3 / 11.8 / 12.5 | mm/s rms | AMCA 204-20 https://www.amca.org/assets/resources/public/Standards%20for%20Member%20Download/amca-204-20.pdf |
| Vibration change rule | caution ≥ 2× baseline, alarm ≥ 4× (A) | ratio | vendor practice https://vibromera.eu/uz/?p=20619 (V) |
| Installed temperature sensor σ | 0.5 calibrated … 1.5 drifted; IPMI bias up to +5 (one-sided) | °C | IEC 60751; Khalili 2019 https://par.nsf.gov/servlets/purl/10094627 |
| Reference DS18B20 σ | 0.17 genuine; Student-t ν = 4 to cover counterfeits | °C | datasheet; https://github.com/cpetrich/counterfeit_DS18B20 |
| Acoustic channel σ (uncalibrated / after `cal`) | 3.4 / correlated with DS18B20 | °C | calc (c = 331.3√(1 + T/273.15)) |
| Spatial σ (same height, 5 cm; uncontained) | 0.3–0.5; 2.0 | °C | runbook; Subzero (V) |
| Prior P(alarm is real) | 0.5, sensitivity 0.2 / 0.8 (A: no base-rate data) | — | A |
| Leak-probe sensitivity / specificity | 0.95 / 0.98 (A) | — | A |
| Crew task time | LogNormal(median = current fixture delay, EF 2) + route ETA (A) | min | A; THERP TRC (secondary) |
| Outage cost if major | LogNormal(ln median 11.91, σ 2.26): median $149k, p90 $2.7M | USD | Uptime AOA 2026 https://itweb.africa/article/uptime-announces-annual-outage-analysis-report-2026/WnxpEv4Y6837V8XL (calc fit) |

---

## 4. Data pulled

All files are listed with URL, retrieval date and licence in `research/SOURCES.md`. Total: **about 30 MB, 9 files across 7 source folders.**

| Dataset | Volume | How it is used |
|---|---|---|
| Open-Meteo archive, DFW, hourly, 2016-01-01 to 2025-12-31: dry-bulb, RH, dew point, wet-bulb, pressure | 87,672 hours × 5 variables (3.4 MB) | Ambient prior and heat-wave extremes, chiller-derate exposure (§2.8) |
| NOAA NCEI Global Hourly, station 72259003927 (DFW airport), 2023, 2024, 2025 (to 27 Aug) | 23,165 routine hourly METARs (20 MB raw ISD CSV) | Ground truth for the reanalysis (bias −0.2 °C) and the 2023 extreme (42.8 °C, 124 h ≥ 40 °C) |
| INL/EXT-21-65055 component reliability (2020 update) | 4.4 MB PDF, about 100 component and failure-mode rows used | Fail-on-demand and fail-to-run priors (§3; `derived/reliability_priors.json`) |
| ASHRAE TC9.9 5th-edition reference card | 160 KB | Envelopes and rate-of-change limits |
| Schneider WP179 | 616 KB | Model form; backtest targets |
| Tradat 2018 (Binghamton, measured) | 1.0 MB | Measured ride-through with fans on; IPMI bias |
| Transcribed published transients | 30 points from 6 sources | Thermal backtest targets (`research/data/published-transients/`) |

Derived outputs:
- `research/derived/dfw_weather_summary.json`
- `research/derived/thermal_backtest_kG1.json` and `thermal_backtest_kG2.json`
- `research/derived/reliability_priors.json`

Scripts, in `research/scripts/`:
- `weather_summary.mjs` and `thermal_backtest.mjs` (plain Node, read-only over the data)
- `bench_engine.ts` (`npx tsx`; imports the engine read-only)

**What could not be pulled.**
- IEEE 493 Annex Q tables and IEEE 3006.8 (paywalled). The Gold Book generator figure is used only through WP75's citation.
- Manufacturer chiller capacity-vs-ambient tables (they come from selection software).
- Any measured data-center leak spread data.
- Any base rate of false temperature or leak alarms in data centers.
- The full text of Zhang & VanGilder 2011 and Lin et al. 2014.
- No local PDF renderer was available. PDF numbers were read through the web-fetch tool. **WP179 Table 2 must be re-checked against the PDF before it is quoted.**

---

## 5. Nemotron design options and recommendation

**Invariant, unchanged.** Nemotron never produces a reported number. Every number shown comes from the engine and is cited by run id. `validate.ts` enforces this.

One clarification the designs rely on: Nemotron may emit **bounded, typed proposal parameters** that steer sampling, for example "force the standby CRAH to fail" or "draw leak rate from its top decile". It already does the equivalent today with `extraFaults` minutes in `run_scenario`. Such parameters change *which trials run*. They never change *what is reported*, because the estimator corrects for them (Design A).

### Design A: Nemotron as red-team proposal distribution for importance sampling ("Stress the plan")

The question this answers: under which plausible compound failures does this response fail, and how likely is that? It is the design that runs a lot of trials.

**How it works.**

1. **Prior ensemble.** The engine draws N₀ = 4,000 trials from the prior p(θ) of §3. θ covers parameters, on-demand failures, crew times and ambient. Each trial is a full cascade run with physics-derived delays. Outcomes per trial and per response option *a*:
   - racks impacted
   - critical services down
   - time to first impact

   Failure is defined as F_a = 1[any criticality-≥ 4 service down by the horizon].

2. **Failure digest.** The engine summarises the failing trials for Nemotron:
   - which grammar families are over-represented among failures (lift = P(family in its top decile | fail) / 0.1)
   - the ESS
   - the current estimate

   Nemotron sees no raw trial numbers beyond what the digest exposes, and each digest is a cited run.

3. **Proposals.** Nemotron returns up to K = 6 *stress regions* from a closed JSON grammar, each with a rationale. Example:

   ```json
   {"label":"hot afternoon + slow restart",
    "terms":[{"family":"ambient_c","op":"quantile_window","lo":0.95,"hi":1.0},
             {"family":"chiller_restart","op":"force","value":"slow_standard"},
             {"family":"crew_delay_mult","op":"quantile_window","lo":0.8,"hi":1.0}]}
   ```

   Allowed `op` values:
   - `quantile_window(lo, hi)` for continuous families
   - `force(state)` / `set_p(p ≤ 0.5)` for Bernoulli families
   - `scale(f ∈ [1/4, 4])` for log-scale families

   `validateProposal` rejects anything else. Each region k defines a proposal density q_k(θ) with a closed form. The grammar is built from distributions that have pdfs: Beta, Bernoulli, LogNormal, Uniform, Triangular, empirical-ambient bins.

4. **Defensive mixture.** The engine draws N₁ = 8,000 trials from

   q = α·p + (1 − α)·Σ_k π_k q_k,   with α = 0.3 and π_k uniform.

   Each trial gets weight w = p(θ)/q(θ) ≤ 1/α = 3.3.

   The self-normalised estimate P̂(F_a) = Σ w·F / Σ w is consistent whatever Nemotron proposes. The bounded weights mean that even an adversarially useless proposal costs at most a 3.3× increase in variance compared with plain Monte Carlo (Hesterberg 1995). Good proposals cut the variance of rare-failure estimates by orders of magnitude.

   Reported per option:
   - P̂ with a 90 % CI from the weighted bootstrap or the delta method
   - ESS
   - for each region, the **prior probability mass** p(region) (computed by the engine: "about 1 in 400 incidents"), the **conditional failure rate** P(F | region), and its **share of the total failure probability**

5. **Second round.** Nemotron sees the updated digest and refines. There are two rounds, and the engine stops early once ESS > 2,000 and the CI half-width is below 25 % of P̂.

6. **Recommendation.** Nemotron writes:
   - the dominant failure modes, from the engine's labels and shares
   - what would rule them out, which is the link to Design B
   - which response is most robust

   Every %, minute, rack count and "1 in N" must match a cited run (extended `validate.ts`, §6).

**Fallback without Nemotron (static artifact, no key).** The cross-entropy method (Rubinstein & Kroese 2004) proposes the regions instead. For each family it fits the elite failing trials' quantile window, then runs the same mixture and estimator. The output schema is identical and `provider: 'local_planner'`.

**Why this use of an LLM is novel and safe.**
- The LLM contributes **semantic compound hypotheses** that local search finds slowly in about 25 dimensions. For example: "the generator starts but string B's aged battery cannot bridge the 3-min transfer while the standby CRAH is out for maintenance".
- The statistics make its contribution *bias-free by construction*: a wrong idea costs variance, never correctness.
- The comparison is measurable: ESS and CI width for Nemotron proposals against the CE fallback against plain MC (§7).

**Budget.**

| Step | Runtime |
|---|---|
| Cascade (measured) | 22–36 µs per trial |
| Zone ODE | about 20 µs per θ, shared across inner draws |
| Water | 60 ms per leak-rate bin; 5 bins cached; arrival interpolated in log rate, since arrival ∝ 1/Q for a volume-limited front (A, check in tests) |
| Round 0 (4,000 trials × 3 options) | about 0.4 s |
| Each IS round (8,000 × 3) | about 0.8 s |
| Total compute | ≤ 2.5 s |
| Nemotron, 2 rounds with lightning-30b | about 2–6 s each |

That puts an evaluation at about 6–15 s with Nemotron, and ≤ 3 s for the local fallback.

### Design B: Nemotron chooses the next scan by expected value of sample information (EVSI)

This replaces the ad-hoc `DECISION_VALUE_FORMULA` (10·[top changes] + shift/3 + …) with a preposterior decision analysis computed from the ensemble.

**Setup.**
- Hypotheses h ∈ H, for example {real, measurement} × leak-rate bins.
- Prior p(h), taken from the §2.6 posterior.
- Actions a ∈ A: do nothing plus the fix options.
- Utility U(a, trial) = −Σ_racks w_crit · 1[impacted] − λ · crew-minutes(a). Here w_crit is the max service criticality on the rack (1 if none), and λ = 0.05 rack-equivalents per crew-minute (A, shown in the UI).

**Per hypothesis and action.** E[U | a, h] comes from the ensemble. Trials are tagged with h, so a single mixture ensemble serves every h via weights. **No extra trials are needed.**

**Per candidate scan s**, with outcomes y in 3–5 bins and p(y | h) from the error model of §2.6:

```
EVSI(s) = Σ_y p(y) · max_a Σ_h p(h|y) E[U|a,h]  −  max_a Σ_h p(h) E[U|a,h]
```

- The units are rack-equivalents saved by scanning before acting.
- EVSI ≥ 0, and it equals 0 exactly when no outcome changes the best action.
- Candidate scans are only those the rig can physically make (rig metrics: inlet temperature, leak).

**Nemotron's role.**
- It sees the EVSI table: top 5 rows, each a cited run.
- It picks one and explains it in operator language.
- It may propose a scan point not in the table; the engine then scores it.
- `validate.ts` checks that `nextScan` is an EVSI row and that any "worth X" number matches.

The novelty is modest; the main value is honesty. "Scan A-11 first: it is the only measurement that could change what you do" is computed, not asserted.

### Design C: Bayesian "faulty sensor vs real failure" posterior with Nemotron gathering evidence

**Engine side.** The §2.6 likelihood-ratio model computes P(real | installed, portable series, slope, neighbours, model prediction). It reports each factor's contribution to the log-LR: offset term, slope term, neighbour term, prior. The posterior becomes the mixture weight of h in Designs A and B, which is how **the portable reading changes the prediction** (audit C2).

**Nemotron's side.** It reads the factor breakdown and writes the explanation. It may request more evidence, from a fixed list:
- second sample at the installed sensor's height
- top/bottom spread
- wait 90 s for the probe to settle
- neighbour rack
- installed-sensor history slope

The engine recomputes after each.

**Limit.** It is useful but is not a "many trials" design, because the posterior is analytic.

### Recommendation

**Build C → B → A, in that order, as one pipeline. Pitch A as the Nemotron feature.**

- **C is the foundation.** It is needed to fix audit C2, C3 and C4 regardless, and without it the evidence does not move the prediction.
- **B uses C's posterior and the ensemble.** It replaces an unjustified formula with a decision-theoretic one at no extra trial cost.
- **A is the genuinely new Nemotron behaviour.** It is an LLM acting as an adaptive importance-sampling proposal over tens of thousands of physics-based trials, with unbiasedness guaranteed by the estimator rather than by trusting the model.

All three run without Nemotron (CE fallback, deterministic EVSI ranking), so the static artifact keeps working.

**Pitch line (accurate after implementation):**

> "When a warning comes in, CenterGuard checks the built-in sensor against the portable reading to get the probability that the failure is real. It then runs tens of thousands of physics-based simulations of the response. Nemotron acts as a red team, steering those simulations toward the compound failures most likely to break the plan, while every number comes from the simulator."

---

## 6. Implementation plan

The steps are ordered; each is file-level and lists its own tests. Other agents are editing `src/domain/workflow.ts`, `src/views/MonitorWorkspace.tsx` and (per the audit) `server/workflowHub.ts`. Steps that touch those files are marked **[coordinate]**. Make those changes additive, with optional fields only, and merge after the other agents land their work.

### Step 0: Stop foreknowledge (audit C1, CRITICAL). Do this first; it is small.

- **New `src/domain/engine/observable.ts`:**
  - `observedFaults(scenario, t): {assetId, t}[]` returns only faults that have an observable step (`detectedAt` ≤ t; move `detectedAt` here from `fixes.ts:96`) or that are inferable from an observed signal. The make-up-flow mismatch at T+11 makes the riser leak inferable from T+11 on, but not at T+4.
  - `scriptedHypotheses(scenario, t)` turns each future or unobserved scripted fault into a **hypothesis** `{assetId, t, label, prior}`:
    - The prior comes from §3 rates × the remaining horizon, for example chiller fail-to-run 3.87e-5/h × 1 h ≈ 4e-5.
    - For incident-implied faults (CRAH-2 at 6.8 mm/s), use the A-labelled conditional prior P(trip within horizon | caution level) = 0.02, with a sensitivity range of 0.005–0.1.
- **`simulate.ts`:** add `ScenarioRunInput.mode: 'script' | 'forecast'`, default `'script'` for the replay and stage.
  - In `'forecast'` mode the run uses `observedFaults(scenario, t)` plus explicitly opted-in hypotheses. Both are listed in a new `run.assumedFaults` field.
  - `readingsAt` / `visualAt` stay script-driven: they are the "world".
- **`fixes.ts` `predictionSummary` (lines 180–199) and `predictFix`:** call the run in forecast mode at `ctx.t`. Label any hypothesis-driven loss in the UI as "if X also happens (P ≈ engine value)".
- **UI copy:** anything computed from the script is "Scenario script", never "prediction". This affects `#/stage`, `#/app/facility` and `#/present`.
- **Tests (`tests/engine/observable.test.ts`):**
  - Property test: for any scenario and t, a forecast at t is invariant to adding or removing scripted faults with t_fault > t that have no observable step before t.
  - At riser-leak T+0 the forecast has no leak clocks.
  - At T+11 it has them.

### Step 1: Evidence posterior and correct verdicts (audit C3, C4; Design C)

- **New `src/domain/engine/evidence.ts`:**
  - `evidencePosterior(input: { metric; installed: Reading; scan: Scan; neighbours: Reading[]; modelBaseline: { mean; sd; slope? }; priorReal?: number; errorModel?: Partial<ErrorModel> }): { pReal; logLR; factors: {name, logLR}[]; verdict: Verdict; measurable: boolean; rationale; qualityFlags }`.
  - `DEFAULT_ERROR_MODEL` holds the §3 σ values as named constants, each with a `basis` string citing the source.
  - Student-t likelihood, ν = 4.
  - Treat the acoustic channels as correlated with `ref_c` once the `cal` flag is present. `scan.ts` must record whether `cal` ran in the hold; add `quality: 'acoustic_calibrated_to_ref'`.
- **`verification.ts`:** keep `compareReadings` and its contract tests. Add `compareWithPosterior` that wraps `evidencePosterior` and returns the same `CompareResult` plus `pReal`, keeping the A04 language rules.
- **`rig/scan.ts`:** add `settled: boolean` and `extrapolatedC` from a first-order fit to the `ref_c` series, and the flag `unsettled_lag` when |slope| > 0.2 °C/min. **Do not change** the existing quality strings; tests rely on them.
- **`server/workflowHub.ts` `verify_scan` [coordinate]:**
  - Replace the `≥ 28` / `> 0.5` rule (lines 56–60) with `compareWithPosterior`.
  - Refuse to verify `heat` (CH-1 supply water) with the air probe: verdict `inconclusive` with "not measurable by the portable rig".
  - For `vibration`, cap the verdict at "motion present".
- **`src/domain/rig/simDevice.ts` + `localBridge.ts`:** make the sim respond to the scanned asset's injected incident. The demo then shows both outcomes.
  - Add a hidden truth per injected incident, `truth: 'real' | 'sensor_fault'`. The presenter picks it, or it defaults to `real` for heat and water and `sensor_fault` for A-11.
  - Implement it with the existing `sim heat high`, `sim supply loss`, `sim leak remote` and `spill` commands.
  - Label the sim "simulated device" everywhere, as today.
- **Tests (`tests/engine/evidence.test.ts`):**
  - The worked examples in §2.6: 24.0 °C → P(real) < 0.01; 31.0 °C → P(real) > 0.95 at π = 0.5.
  - Monotonic in reference value.
  - `measurable: false` for supply-water metrics.
  - Rationale never contains "broken" or "safe".
  - A calibration test on synthetic truth: draw 10k cases from the error model, bin P(real), and require the observed frequency to fall within ±0.05 of each bin's mean.

### Step 2: Physics zone model and priors

- **New `src/domain/engine/priors.ts`:**
  - Typed distributions `{ kind: 'beta'|'bernoulli'|'lognormal'|'uniform'|'triangular'|'empirical'; …; sample(rand); logpdf(x); quantile(u) }`.
  - `PRIORS: Record<FamilyId, Prior & { basis: string; url: string }>`, transcribed from §3 and `research/derived/reliability_priors.json`.
  - Families: `gen_fts`, `ats_ftt`, `ups_transfer_fail`, `standby_crah_fts`, `chiller_restart_fail`, `chiller_restart_min`, `battery_soh_A`, `battery_soh_B`, `loop_l_per_kw`, `k_G`, `it_eps`, `rack_mass`, `ceiling_m`, `plenum`, `t_trip`, `leak_rate`, `retain_mm`, `drain_lpm`, `crew_mult`, `ambient_c`, `chiller_derate`.
  - `ambient_c`: embed a 12 × 24 table of mean/p90/max from `dfw_weather_summary.json`. That is about 2 KB. Do not ship the raw CSV.
- **New `src/domain/engine/thermalZone.ts`:**
  - `zonesFor(facility)` builds a north zone (CRAH-1/3, rows A–B), a south zone (CRAH-2/4, rows C–D) and the GPU DLC racks via CDU.
  - `simulateZones(zones, events, θ, horizonMin): { inlet(zoneId, tMin): number; crossing(zoneId, thresholdC): number | null }`.
  - Events: fan loss per CRAH, chilled-water loss, chiller restart with ramp, load shed, portable cooling.
  - Explicit Euler with dt = 1 s, as in `research/scripts/thermal_backtest.mjs`, which is the reference implementation to port.
  - Keep `thermal.ts` `inletTempAt` exported for compatibility, reimplemented by evaluating a single-zone run (cached by rack).
  - Update `docs/ENGINE_CONTRACT.md` (audit S3) in the same PR. That is outside this dossier's write scope; the implementer does it.
- **`fixture.ts`:**
  - Mark the CH → P and P → CRAH `cools` edges `derivedBy: 'thermalZone'`. CRAH → rack and CDU → GPU become `delaySource: 'thermalZone'` (new optional field on `DependencyEdge` in `types.ts`), and the cascade asks the zone model for their per-trial delay.
  - Fix the vibration thresholds to BV-3 (§2.4). Add `baseline` to the CRAH-2 seed and a ratio rule in `readings.ts` `severityFor` via an optional `Threshold.ratioWarn` / `ratioAlarm`.
- **Tests:**
  - `tests/engine/thermalZone.backtest.test.ts` loads `research/data/published-transients/cooling_outage_points.csv` (the test may read it from the repo) and asserts, at k_G = 2:
    - WP179 Example 1: baseline peak 41.1 ± 1.5 °C after the loop-volume fit; 5-min restart 36.7 ± 2.5 °C.
    - CFD 60 s: 34.7 ± 1.5 °C. CFD 300 s: 37.3 ± 3 °C.
    - Density monotonicity.
    - Energy conservation: with Q = 0, ∫P dt = Δ(C_a T_a + C_m T_m + C_w T_w) within 0.5 %.
  - DLC: time to throttle in 0.3–2 min at 78 % load.

### Step 3: Hierarchical ensemble (fixes S1 coverage; supports Designs A and B)

- **`cascade.ts`:** refactor without changing `runCascade`'s output:
  - `compileGraph(facility, extraEdges): Compiled` holds the indices, groups and order.
  - `runOnce(compiled, delays: Float64Array, faultT, fixT, scratch): { loss: Float64Array; cause: Int32Array }`.
  - `runCascade` becomes a loop over `runOnce`. The existing tests (`tests/engine/*cascade*`) must still pass bit-for-bit with seed 7.
- **New `src/domain/engine/ensemble.ts`:**
  - Signature: `runEnsemble({ facility, scenario, t, evidence, options: FixOption[], outer = 256, inner = 16, seed, proposal?: Mixture }): Ensemble`.
  - For each outer θ ~ q:
    - Compute the weight w = p(θ)/q(θ) by summing `logpdf` over the families.
    - Run `simulateZones` once per zone event set.
    - Look up the water arrival for the leak-rate bin, interpolated in log Q.
  - Then sample on-demand Bernoullis. A generator failing to start becomes an extra fault: removing the GEN → ATS edge for that trial is equivalent.
  - Inner draws: crew times and the remaining triangular edges.
  - `runOnce` is called per option, including "no action".
  - **Hypotheses from Step 0 and Step 1** enter as a Bernoulli family with the posterior or prior as p (e.g. `h_real ~ Bernoulli(pReal)`), so the evidence moves the prediction.
  - Output per option:
    - `trials` and `ess`
    - `racksImpacted: {p10, p50, p90}` (weighted quantiles)
    - `pServiceDown` with `ci90`
    - `firstImpactMin: {p10, p50, p90} | null`
    - `perRack: Record<ID, {pImpact, p50Min}>`
    - `regions` (Design A attribution)
    - `trialsDigest` (Design A input)
  - Also a typed-array outcome store for EVSI reuse: `hTag`, `w`, `U` per option.
  - Weighted quantiles: sort by value, cumulative normalised weight.
  - The seed is derived from `hash(incidentId, t, evidenceHash)`, so replays are identical.
- **Runtime budget.** 256 × 16 = 4,096 trials per option × 4 options ≈ 0.5 s (measured cascade cost). The zone ODE adds 256 × 2 zones × 20 µs = 10 ms. Water is 5 bins × 60 ms, cached per scenario. Target: **≤ 1.0 s in Node, ≤ 1.5 s in the browser.**
  - In the artifact, run it in a module Web Worker (`src/workers/ensemble.worker.ts`, imported with `?worker&inline` so the single-file artifact build keeps working). Fallback: main thread with `await` yields every 512 trials.
  - Add a `budgetMs` option that lowers `outer` adaptively.
- **`fixes.ts`:**
  - `predictFix` returns `FixPrediction` plus an optional `ensemble` summary, keeping the old fields: `racksWithout` = p50 of `racksImpacted`.
  - Fix the cache key (C12).
  - Fix delays use the route ETA from `routing.ts` + the LogNormal task time + Bernoulli failure.
- **Tests (`tests/engine/ensemble.test.ts`):**
  - Determinism for the same seed.
  - Weights are all 1 when q = p.
  - Weighted quantiles match unweighted ones when w ≡ 1.
  - The hierarchical ensemble's p10–p90 covers the "reality" draws of a prior-predictive check at 80 ± 5 % (calibration by construction, §7.2).
  - Runtime under 1.5 s for 4 × 4,096 trials (`it.skipIf(process.env.CI_SLOW)`).

### Step 4: EVSI scan value (Design B; audit C13)

- **New `src/domain/engine/evsi.ts`:**
  - `scanEvsi(ensemble, candidates: {assetId, metric, point}[], errorModel): {assetId, metric, point, evsi, bestActionIfNoScan, bestActionByOutcome: {bin, pBin, action}[]}[]`.
  - It reuses the ensemble's tagged trials. There are no new trials.
- **`server/director/tools.ts`:**
  - `scan_value` returns `evsi` and the per-outcome best actions. Keep `decisionValue` as a deprecated alias equal to `evsi`, rounded to 1 decimal, so `planner.ts` keeps working. Update `planner.ts` to rank by `evsi`.
  - **Signed shifts (audit C13).** `shift()` at lines 249–253 must return signed `deltaMin` (b − a; positive = later). Add `direction: 'earlier' | 'later' | 'unchanged'` fields to `CompareResult.earliest` / `firstRackLoss` and to `ScanValueResult`. Update the tool descriptions to say "positive = later = more time".
- **Tests:**
  - EVSI ≥ 0, and 0 when every outcome has the same best action.
  - It matches a brute-force recomputation on a toy two-hypothesis case.
  - Signed shift: when corroborated is earlier, the sign is negative.

### Step 5: Red-team importance sampling (Design A)

- **New `src/domain/engine/stress.ts` (pure, used by the server and the artifact):**
  - `ProposalSpec` grammar and `validateProposal(spec): {ok, errors}`.
  - `buildMixture(priors, specs, alpha = 0.3)`.
  - `crossEntropyProposals(ensemble, k = 4)` is the fallback proposer.
  - `failureDigest(ensemble)` gives lifts per family, ESS, P̂ and CI.
  - `attributeRegions(ensemble, specs)` gives per region its prior mass, P(F | region) and share of P(F).
- **`server/director/tools.ts`:** add two tools. Each output counts as a run and is registered with `addNumbers` (percentages, counts, "1 in N", minutes):
  - `stress_digest(option)` → digest (cited run id `stress-N`).
  - `stress_test({option, proposals: ProposalSpec[]})` → runs `runEnsemble` with the mixture and returns the estimates and region attribution.
- **`server/director/director.ts` / `nemotron.ts`:**
  - System-prompt section explaining the grammar and that proposals only steer sampling.
  - At most 2 stress rounds and 6 proposals per round.
  - Overall wall-clock cap 20 s, then fall back to `crossEntropyProposals`.
  - Model `nvidia/nemotron-3.5-lightning-30b-a3b`. **Do not use Ultra-550b** in the loop: it takes > 15 s per call.
- **`server/director/validate.ts`:**
  - Extend the `CLOCK` regex family with `PERCENT = /(\d+(?:\.\d+)?)\s*%/`, `COUNT = /(\d+)\s+(?:racks?|services?|assets?)/` and `ODDS = /1\s+in\s+(\d[\d,]*)/`. Scrub any value not in the cited runs' numbers.
  - **Direction check (audit C13):** if the text says "later", "more time" or "buys" next to a cited shift whose sign is negative (or vice versa), replace the sentence with the engine's own templated sentence and add a warning.
  - **Provenance check (audit top-15 item 14 and C13):** reject "rig is trustworthy" or "sensor is broken" claims. Use the regex list from the A04 rules.
- **Tests (`tests/director/stress.test.ts`):**
  - **Unbiasedness:** on a case with true P(F) ≈ 1e-2, the mean of 50 IS estimates with random valid proposals is within 3 SE of a 200k-trial plain-MC estimate. Mark it slow and run nightly.
  - **Bounded weights:** w ≤ 1/α.
  - **Grammar rejection:** out-of-range `set_p` > 0.5, unknown family, more than 6 terms.
  - **Validator:** a fabricated "3.2 %" not in the runs is stripped; "later" with a negative shift is flagged.

### Step 6: Evaluate path and UI (audit C2, C6) **[coordinate]**

- **`server/workflowHub.ts` `evaluate`** (lines about 64–83 at the time of writing):
  1. Map each `ErrorKind` to its own incident scenario, built from the injected incident alone. Do **not** use `scn-riser-leak` for A-11 or CRAH-2 (audit S4). Add these to `src/domain/scenarios/index.ts` as `incident-*` scenarios with no future scripted faults:

     | ErrorKind | Scenario | Content |
     |---|---|---|
     | `sensor` | `incident-rack-inlet` | A-11 inlet condition; hypothesis = local recirculation / cooling deficit at A-11 |
     | `heat` | `incident-chiller-trip` | CH-1 tripped; CH-2 healthy; hypothesis "CH-2 also trips" at its prior |
     | `water` | `incident-riser-leak` | Leak with the observed make-up-flow mismatch; leak-rate prior conditioned on the observed rate |
     | `vibration` | `incident-crah-vibration` | CRAH-2 at caution; hypothesis "trips within the horizon" at its prior (A) |

  2. Compute `evidencePosterior` from the issue's evidence scan (Step 1). Pass `pReal` to `runEnsemble`.
  3. Run `runEnsemble` for "no action" plus the top 3 `fixOptionsFor` options, then `scanEvsi`, then (bridge only) the director with stress tools.
  4. Pass log context as **structured input, not prose** (audit C6). Add `DirectorInput.context?: { events: {id, at, summary}[]; notes: string[] }` (cap 20 events × 200 chars) and a `get_context` tool. Keep `question` ≤ 500 chars. That fixes the truncation at `tools.ts:136` without raising the cap on an untrusted string.
- **`src/domain/workflow.ts` `WorkAnalysis.comparison` [coordinate].** Add optional fields only, so the current UI keeps rendering:

  ```ts
  comparison?: {
    action: string; without: number; with: number; saved: number; assumptions: string;   // existing; = p50 values
    ensemble?: {
      trials: number; ess: number; provider: 'nemotron' | 'local_planner';
      pReal?: number;                                   // evidence posterior used
      without: { racksP10: number; racksP50: number; racksP90: number; pServiceDown: number; ci90: [number, number]; firstImpactP50Min: number | null };
      with:    { racksP10: number; racksP50: number; racksP90: number; pServiceDown: number; ci90: [number, number]; firstImpactP50Min: number | null };
      dominantFailure?: { label: string; priorOneIn: number; shareOfFailure: number };   // Design A
      nextScan?: { assetId: string; point: string; evsi: number; why: string };          // Design B
      coverageNote: string;                             // e.g. "model range; validated coverage 78 % (report 2026-11-08)"
    };
  };
  ```

- **`src/views/MonitorWorkspace.tsx` "2. Evaluate a response" [coordinate]:** inside the existing `.mw-model-compare` block, use plain ISA-101 styling (colour only for abnormal):
  - "Without response: 31 racks (model range 12–44) · critical service down P = 38 %"
  - "With response: 2 racks (0–9) · P = 3.1 % (2.4–3.9 %)"
  - One line "Biggest remaining risk: {dominantFailure.label} (about 1 in {priorOneIn} incidents; {share} of remaining risk)"
  - One line "Measure next: {nextScan}"
  - Small print: `trials`, `ess`, `coverageNote`, and "pReal = P(alarm reflects a real condition)".

  These numbers are illustrative of format only; the engine fills them. The existing `analysis.comparison.without/with` text keeps working when `ensemble` is absent.
- **`src/state/localBridge.ts`:** make sure the static artifact's workflow `evaluate` path calls the same pure functions (Steps 1–5 are all in `src/domain/engine`) with the CE fallback. If the workflow hub is not mounted in `localBridge`, mount it or call the pure functions directly. This must run with no network.

### Step 7: Validation harness and reporting (§7)

- **`scripts/validate/harness.ts`:**
  - Add a `reality: 'perturbed' | 'prior_predictive' | 'out_of_prior'` option.
  - Add the PIT histogram and coverage at 50/80/90 % to `report.ts`.
  - Add the thermal backtest summary and the evidence-posterior calibration (Brier score, reliability bins).
  - Write `reports/validation-<date>-<mode>.md` as now.
- Surface the latest coverage in `coverageNote` (Step 6).

### Audit traceability

| Audit item | Fixed by |
|---|---|
| (1) C1: forecasts read the script's future faults (`fixes.ts:180-199`, `fixture.ts:287`) | Step 0 (`observable.ts`, forecast mode, invariance property test) |
| (2) C2/S4: evaluate uses the CH-2 what-if (48 vs 0), ignores the portable reading, and evaluates A-11/CRAH-2 in the riser-leak scenario (`workflowHub.ts:72-79`) | Step 6.1 (per-kind incident scenarios), 6.2–6.3 (`pReal` into the ensemble; the CH-2 trip is a prior-weighted hypothesis, not a fact) |
| (3) C3/C4: verdict never compares installed vs portable; `compareReadings` unused; sim makes everything "disagree" | Step 1 (`evidencePosterior` / `compareWithPosterior`, measurability gate, sim truth per incident) |
| (4) C6: question truncated to 500 chars at `tools.ts:136` | Step 6.4 (structured `context` + `get_context` tool) |
| (5) C13: unsigned shifts → inverted claims | Step 4 (signed deltas + direction fields), Step 5 (validator direction check) |
| (6) S1: 24 % coverage | Step 3 (hierarchical, correlated sampling), Step 7 (coverage reporting), UI label "model range" until 75–85 % |
| S2: all-or-nothing 48/48 | Step 3 outputs (distributions, per-rack P, time to impact), §2.1 two-threshold definition |
| S3: circular calibration, stale contract | Step 2 (physics zone model, sourced priors; update `ENGINE_CONTRACT.md`) |
| C12: cache key | Step 3 (`fixes.ts`) |

---

## 7. Validation plan

### 7.1 Thermal backtest (physics vs published curves)

- **Targets:** `research/data/published-transients/cooling_outage_points.csv` (30 points, 6 sources).
- **Procedure:** configure `thermalZone` with each source's stated geometry and load. Fit only the declared unknowns, using a single global k_G and, for WP179 Example 1, the loop volume. Report residuals per point.

| Target | Acceptance |
|---|---|
| WP179 Example 1 | three peaks within ±2.5 °C; back below 32 °C within ±5 min |
| WP179 CFD | 60 s within ±1.5 °C; 300 s within ±3 °C |
| Tradat 2018, fans on | time to 32 °C within a factor of 1.5. Lab geometry is partly unknown, so this is a shape check; use the external-sensor column, since IPMI reads hot. |
| Alkharabsheh 2017 | throttle times within a factor of 1.5 |
| Opengate / Khankari / Intel | qualitative ordering only. These are per-cabinet or press sources: the model must be *slower* than per-cabinet CFD and *faster* than Tradat's fans-on case at the same density. |

- **Current status (`research/scripts/thermal_backtest.mjs`):** at k_G = 2 it meets the WP179 CFD criteria (34.0 at 60 s, 39.1 at 300 s, against 34.7 and 37.3) and the Example 1 baseline and 5-min peaks. It misses the 4-min peak by about 2.5–3.4 °C.
- **Fix for the miss:** probably a two-node water loop, splitting coil-local water from loop water. Add it only if the test fails after porting.

### 7.2 Calibration of percentiles

Three regimes:

1. **Prior-predictive (self-consistency).** Draw "reality" from the same priors as the model. Coverage of p10–p90 must be 80 ± 3 % and the PIT histogram flat (χ² p > 0.01). Failing this means a bug, such as wrong weighting or quantiles.
2. **Perturbed (the current harness).** Coverage target 75–85 %.
   - Currently 24 %. Expected to rise once epistemic sampling exists, since the harness bias of ±20 % sits inside the new priors.
   - Report by asset type, plus first-rack accuracy and the predicted vs realised saved racks. The latter target is |mean bias| ≤ 10 %; currently +36 %.
3. **Out-of-prior (robustness).** The harness's `harsh` level, with delays widened by 50 % beyond the priors. Report the coverage drop, and show it in the UI's `coverageNote` as the honest worst case.

### 7.3 Evidence posterior

- **Synthetic truth:** 10k cases per incident kind, drawn from the error model with known H.
- **Reliability diagram** (10 bins): every bin within ±0.05.
- **Brier score** reported.
- **Robustness:** with a counterfeit-probe offset of +3 °C injected in 10 % of cases, the share of cases with P(real) ≥ 0.99 when H is false must stay ≤ 1 %. This is the reason for the Student-t likelihood.
- **Live rig check** (when hardware is ready): 20 paired holds against a reference thermometer to estimate σ_ref, the settling time constant and σ_spatial at the runbook point. Replace the A values in `DEFAULT_ERROR_MODEL`.

### 7.4 Importance sampler

- **Unbiasedness:** see the Step 5 test.
- **Efficiency:** compare plain MC, CE and Nemotron proposals at equal trial counts across the 6 named scenarios. Report:
  - ESS / N
  - CI half-width / P̂
  - wall-clock

  Claim in the pitch only what this shows. If Nemotron does not beat CE, say "matches cross-entropy and explains the failure modes".
- **Rare-event check:** generator fail-to-start alone (p = 2.2e-3) must be recovered within 3 SE by IS with N = 8,000, where plain MC sees about 18 events.

### 7.5 EVSI

- EVSI ≥ 0 everywhere.
- EVSI = 0 for scans that cannot change the decision.
- On the riser-leak incident at T+11, the floor-wet scan at the predicted front must rank above an inlet scan.
- On A-11 with an installed 34.2 °C reading, the A-11 inlet scan must rank first.

### 7.6 Foreknowledge regression

- For all named and random scenarios: forecast(t) is invariant to unobserved future faults (the Step 0 property test).
- Reported in the validation summary as "foreknowledge leaks: 0".

---

## 8. Limitations (honest ranges, not fake precision)

- **No site data.** The fixture hall has no measured ceiling height, raised floor, loop volume, CRAH capacity or battery curve. The ranges in §3 are deliberately wide. The physics model reduces the *structural* error (wrong shape, circular calibration), not the parameter error.
- **The thermal model is lumped, not CFD.**
  - It cannot represent hot spots, local recirculation at one rack, or containment leakage.
  - Single-rack inlet can be several °C hotter than the zone (Khankari's per-cabinet CFD is about 2–4× faster to 35 °C than well-mixed).
  - k_G is an empirical fudge calibrated on two simulated cases from one vendor; there are no measured full-room transients at known parameters.
  - The fans-on loop volume is not identifiable from WP179.
- **Reliability data come from nuclear plants**, which are heavily tested and maintained. They are optimistic for commercial sites. The NREL Hong Kong set (1.65 % generator FTS) is the "poorly maintained" bound and should appear in sensitivity, not be hidden.
- **Not found, so still assumptions (A):**
  - data-center crew response times
  - battery runtime distributions for aged strings
  - chiller derate per °C
  - P(chiller trip | ambient)
  - drain capacity
  - leak-mode weights
  - P-F interval for CRAH bearings
  - DS18B20 time constant in this probe housing
  - the base rate of false inlet alarms
- **Uptime cost figures are survey self-reports** of respondents' most recent *major* outage, across organisations. They are context, not a per-facility loss model. The lognormal fit is constrained by only two exceedance points.
- **ISO 20816-3:2022 and ISO 14694 tables were not read directly.** AMCA 204-20 was. Whether 20816-3 changed any boundaries is unverified.
- **WP179 Table 2** cell alignment was reconstructed from scrambled text. Opengate 2007 is known only from press coverage.
- **Validation is model-vs-perturbed-model** plus a backtest against *simulated* published curves. The only measured transients are Tradat 2018 and Alkharabsheh 2017. A measured site replay is the next real validation.
- **The rig's vibration channel is qualitative** and cannot verify mm/s or ISO/AMCA zones under any design.

---

## 9. References

Retrieved 2026-11-07 unless noted. M = measured, S = simulated, V = vendor claim.

**Outage statistics**
1. Uptime Institute, *Annual Outage Analysis 2026* press release (13 May 2026), via ITWeb: https://itweb.africa/article/uptime-announces-annual-outage-analysis-report-2026/WnxpEv4Y6837V8XL
2. Uptime Institute, *Annual Outage Analysis 2025*: https://intelligence.uptimeinstitute.com/resource/annual-outage-analysis-2025 ; press release (6 May 2025): https://uptimeinstitute.com/about-ui/press-releases/uptime-announces-annual-outage-analysis-report-2025
3. Uptime Institute, *Annual Outage Analysis 2024*: https://intelligence.uptimeinstitute.com/resource/annual-outage-analysis-2024
4. Uptime Institute 2022 outage analysis press release: https://fr.uptimeinstitute.com/about-ui/press-releases/2022-outage-analysis-finds-downtime-costs-and-consequences-worsening

**Thermal envelopes and transients**
5. ASHRAE TC9.9, *Thermal Guidelines for Data Processing Environments*, 5th ed. (2021), reference card: https://www.ashrae.org/file%20library/technical%20resources/bookstore/supplemental%20files/therm-gdlns-5th-r-e-refcard.pdf
6. Lin, Zhang, VanGilder, *Data Center Temperature Rise During a Cooling System Outage*, Schneider Electric WP179 (2013) (S): https://ecl-ips.com/wp-content/uploads/2014/01/apc-data-centre-temperature-rise-during-a-cooling-system-outage.pdf
7. Schneider Electric patents US9418179B2 (https://patents.google.com/patent/US9418179B2) and US10817033 (https://patents.google.com/patent/US10817033)
8. Ibrahim, "Characterization of server thermal mass", *Electronics Cooling*, Dec 2013 (M): https://www.electronics-cooling.com/2013/12/characterization-server-thermal-mass/
9. Tradat et al., chilled-water interruption experiments, InterPACK2018-8334 (M): https://par.nsf.gov/servlets/purl/10094472 ; Tradat et al., ITherm 2018 CRAH blower failure: https://par.nsf.gov/servlets/purl/10074935
10. Alkharabsheh, Ramakrishnan, Sammakia, *Failure Analysis of Direct Liquid Cooling System in Data Centers*, InterPACK2017-74174 (M): https://par.nsf.gov/servlets/purl/10058025
11. Khalili et al., "Impact of internal recirculation on server inlet sensors", *J. Electronic Packaging* 2019, doi:10.1115/1.4042983 (M): https://par.nsf.gov/servlets/purl/10094627
12. Opengate / Active Power 2007 report, via FMLink: https://www.fmlink.com/report-looks-at-impact-of-power-outages-on-data-centers/
13. Khankari, *Thermal Mass Availability for Cooling Data Centers During Power Shut-Down* (ASHRAE Trans.), via Upsite: https://www.upsite.com/blog/staying-cool-data-center-understanding-relationship-uptime-intake-temperatures/
14. Intel IT, *Thermal Storage System Provides Emergency Data Center Cooling* (2007): https://www.intel.com/content/dam/doc/white-paper/intel-it-thermal-storage-system-provides-emergency-data-center-cooling-paper.pdf
15. Kummert, Dempster, McLean, Building Simulation 2009 (S): https://www.aivc.org/sites/default/files/BS09_1299_1305.pdf
16. Trane rapid restart (V): https://elibrary.tranetechnologies.com/public/commercial-hvac/Literature/Sales/AC-SLB003-EN_10302024.pdf ; Trane CenTraVac: https://www.trane.com/commercial/north-america/canada/en/products-systems/chillers/data-center-chillers/centravac-data-center-chiller.html ; Daikin RapidRestore: https://www.daikinapplied.com/news/blogs/RapidRestore ; RagingWire case, Data Center Knowledge: https://datacenterknowledge.com/business/speeding-up-those-chiller-restarts
17. Dell iDRAC8 thermal thresholds: https://www.manualslib.com/manual/1244291/Dell-Idrac-8.html?page=105 ; Dell KB 000181231: https://www.dell.com/support/kbdoc/en-us/000181231/

**Reliability**
18. Ma, Wierman, Kvarfordt, INL/EXT-21-65055 (2021), industry-average component performance, 2020 update (M): https://www.osti.gov/servlets/purl/1847110
19. Marqusee & Jenket (NREL), *Reliability of Emergency and Standby Diesel Generators* (M): https://www.osti.gov/servlets/purl/1659849
20. McCarthy & Avelar, *Comparing UPS System Design Configurations*, Schneider WP75 Rev 4 (Gold Book 1997 inputs): https://content.voltimum.com/br/1537/scb_02_ups_system_wp75r4.pdf
21. Müller & Strunz, *J. Eng.* 2019 (IEEE 493-2007 Table 3-1 utility data): https://d-nb.info/1201725119/34
22. Eaton AP083006EN, medium-voltage breaker reliability (IEEE 493-1980 data): https://www.eaton.com/content/dam/eaton/products/medium-voltage-power-distribution-control-systems/vacclad-w-pages/medium-voltage-circuit-breakers-reliability-and-availability-for-service-ap083006en.pdf
23. NFPA 110 10-second start, ACHR News: https://achrnews.com/articles/158160-standby-power-behind-the-10-second-start
24. Vertiv UPS battery e-book (Ponemon 2013 citation): https://inte.vertiv.com/48fffb/globalassets/shared/ups-battery-maintenance-solutions-ebook-chapter-1-4-0.pdf ; IEEE 450 practice summary: https://open-exam-prep.com/study-guides/neta-ett-level-ii/grounding-batteries-devices/battery-load-test-ieee-450-vrla
25. THERP time-reliability curve, NUREG/CR-1278, as reproduced in K-HRA work (secondary): https://kns.org/files/pre_paper/50/23A-264-김재환.pdf

**Water**
26. Google Cloud incident report, europe-west9, April 2023 (M): https://status.cloud.google.com/incidents/dS9ps52MUnxQfyDGPfkY
27. Leak-size table (utility handout): https://www.assumptionparishwaterworks.com/documents/1616/Simply_Leak_Detection.pdf ; "250 gal/day" claim (unreliable): https://www.claimsjournal.com/news/national/2012/02/21/201175.htm
28. de Gennes, Brochard-Wyart, Quéré, *Capillarity and Wetting Phenomena*, Springer 2004 (puddle thickness 2κ⁻¹ sin(θ/2))
29. Leak sensors (V): RLE LD310 https://assets.kele.com/Catalog/11%20Level/PDFs/LD310%20Series%20Catalog%20Page.pdf ; Kidde ENV-WLEAK https://kidde.com/fire-safety/en/au/media/Datasheet_ENV-WLEAK-COMBO5M_7_tcm516-211655.pdf ; Watts on false alarms https://www.watts.com/blog/prevent-false-leak-alarms-in-data-centers

**Vibration**
30. AMCA 204-20, *Balance Quality and Vibration Levels for Fans*: https://www.amca.org/assets/resources/public/Standards%20for%20Member%20Download/amca-204-20.pdf
31. ISO 10816-1:1995/Amd 1:2009 sample: https://cdn.standards.iteh.ai/samples/52123/63defcb69749490d9393bdc15997cee6/ISO-10816-1-1995-Amd-1-2009.pdf ; ISO 20816-3 zone summary (Fabrico): https://www.fabrico.io/blog/iso-20816-vibration-severity-zones/ ; baseline-ratio practice (Vibromera, V): https://vibromera.eu/uz/?p=20619

**Sensors**
32. DS18B20: Analog Devices note https://support.analog.com/en-US//knowledgebase/article/000095991 ; Petrich, counterfeit DS18B20 study (M): https://github.com/cpetrich/counterfeit_DS18B20
33. IEC 60751 tolerance classes (Senmatic): https://www.senmatic.com/sensors/knowledge/iec-60751-sensor-tolerance-classes ; NTC drift (Ametherm via DigiKey): https://www.digikey.com/es/ptm/a/ametherm/ntc-thermistor-sensors/tutorial?slide=9 ; Sensirion SHT3x datasheet: https://sensirion.com/file/datasheet_sht3x_digital
34. HVAC fault prevalence, *Science and Technology for the Built Environment* 2023: https://www.tandfonline.com/doi/full/10.1080/23744731.2023.2263324
35. Speed of sound vs humidity, Rane note: https://www.ranecommercial.com/legacy/pdf/ranenotes/Enviromental_Effects_on_the_Speed_of_Sound.pdf
36. Cold-aisle stratification (Subzero, V): https://www.subzeroeng.com/learn/data-centers/cold-aisle-containment/ ; ASHRAE measurement points (Raritan): https://www.raritan.com/blog/ashrae-colder-is-not-better-for-a-data-center1
37. ISA-18.2 / EEMUA 191 alarm rates (Yokogawa): https://www.yokogawa.com/tr/library/resources/media-publications/implementing-alarm-management-per-the-ansi-isa-182-standard-control-engineering/

**Weather and chiller rating**
38. Open-Meteo Historical Weather API (CC BY 4.0): https://open-meteo.com/en/docs/historical-weather-api
39. NOAA NCEI Global Hourly (ISD), AWS Open Data mirror: https://noaa-global-hourly-pds.s3.amazonaws.com/index.html
40. US5806327A (condensing temperature vs ambient): https://patents.google.com/patent/US5806327

**Statistics**
41. Hesterberg, "Weighted average importance sampling and defensive mixture distributions", *Technometrics* 37(2):185–194, 1995
42. Rubinstein & Kroese, *The Cross-Entropy Method*, Springer, 2004
43. Raiffa & Schlaifer, *Applied Statistical Decision Theory*, Harvard, 1961 (EVSI / preposterior analysis)





