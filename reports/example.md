# Validation run — 2026-11-08

36 scenarios (fixtures, real incidents, 30 random) × 50 perturbed iterations each, perturbation **default**, seed 1, 58 s.

Perturbation: delays widened ±30% with a per-iteration bias of ±20%, start times ±2 min, leak/spread rates ±40%, 20% chance a first signal is missed (up to 5 min extra detection lag).

## Overall
|  | losses | coverage p10–p90 | p50 |error| | bias (real − p50) | missed | false alarms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| all | 86067 | 24 % | 3.0 min | +0.9 min | 0 % | 10 % |

First rack right: **53 %** of 1766 judged iterations.

Fixes: 36 scenarios checked; predicted 32.1 racks saved on average vs **23.6** realized; realized within ±2 racks of the prediction in **67 %** of iterations.

## By scenario kind
| kind | losses | coverage p10–p90 | p50 |error| | bias (real − p50) | missed | false alarms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| real | 13251 | 27 % | 4.3 min | +1.2 min | 0 % | 12 % |
| what-if | 1994 | 56 % | 4.8 min | +2.5 min | 0 % | 29 % |
| random | 70822 | 23 % | 2.7 min | +0.8 min | 0 % | 8 % |

## By asset type
| type | losses | coverage p10–p90 | p50 |error| | bias (real − p50) | missed | false alarms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| rack | 66582 | 25 % | 3.0 min | +0.8 min | 0 % | 12 % |
| crah | 5598 | 20 % | 3.6 min | +1.6 min | 0 % | 4 % |
| pdu | 3221 | 15 % | 2.8 min | +0.7 min | 0 % | 1 % |
| pump | 2668 | 27 % | 3.5 min | +1.2 min | 0 % | 1 % |
| chiller | 2074 | 4 % | 2.1 min | +0.2 min | 0 % | 1 % |
| battery | 1756 | 39 % | 3.0 min | +1.0 min | 0 % | 0 % |
| cdu | 1496 | 25 % | 3.7 min | +1.8 min | 0 % | 3 % |
| ups | 1411 | 18 % | 3.0 min | +0.9 min | 0 % | 1 % |
| ats | 815 | 5 % | 2.6 min | +0.2 min | 0 % | 4 % |
| utility | 152 | 1 % | 1.1 min | -0.0 min | 0 % | 0 % |
| generator | 149 | 3 % | 0.9 min | +0.0 min | 0 % | 0 % |
| pipe | 145 | 1 % | 1.0 min | -0.1 min | 0 % | 0 % |

## Named scenarios
| scenario | losses | coverage p10–p90 | p50 |error| | bias (real − p50) | missed | false alarms | first rack right |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| scn-riser-leak | 3033 | 8 % | 5.8 min | -1.7 min | 0 % | 9 % | 100 % |
| scn-gen-nostart | 2941 | 46 % | 2.5 min | +1.7 min | 0 % | 0 % | 6 % |
| scn-chiller-trip | 1994 | 56 % | 4.8 min | +2.5 min | 0 % | 29 % | 38 % |
| real-london-heatwave-2022 | 1509 | 59 % | 4.4 min | +1.7 min | 0 % | 47 % | 30 % |
| real-ovh-sbg2-2021 | 3159 | 0 % | 2.5 min | +0.3 min | 0 % | 0 % | 100 % |
| real-azure-syd-2023 | 2609 | 41 % | 6.7 min | +5.0 min | 0 % | 6 % | 32 % |

## Fixes
| scenario | best fix (ordered at) | predicted saved | realized mean | realized range | |Δ| ≤ 2 racks |
| --- | ---: | ---: | ---: | ---: | ---: |
| scn-riser-leak | Close the isolation valves on PIPE-L2 (T+12) | 48 | 44.2 | 0–48 | 92 % |
| scn-gen-nostart | Start GEN-1 manually (T+3) | 48 | 38.3 | 12–48 | 28 % |
| scn-chiller-trip | Restart CH-1 manually (T+2) | 48 | 32.1 | 0–48 | 44 % |
| real-london-heatwave-2022 | Restart CH-1 manually (T+5) | 48 | 22.1 | 0–48 | 28 % |
| real-ovh-sbg2-2021 | Release fire suppression at UPS-B (T+4) | 48 | 48.0 | 48–48 | 100 % |
| real-azure-syd-2023 | Restart CH-1 manually (T+3) | 48 | 44.9 | 21–48 | 80 % |
| rnd-dlbovs | Reset the PDU-B2 main breaker (T+4.5) | 24 | 21.6 | 0–24 | 90 % |
| rnd-dgek10 | Restart CH-1 manually (T+4.5) | 48 | 24.0 | 0–48 | 16 % |
| rnd-1f2yu8 | Cover CRAH-1 with the standby unit (T+1) | 24 | 22.5 | 4–24 | 86 % |
| rnd-aywsyk | Close the isolation valves on PIPE-L2 (T+9.5) | 48 | 20.2 | 0–48 | 42 % |
| rnd-d4pyw5 | Reset the PDU-A2 main breaker (T+13) | 20 | 16.8 | 0–20 | 84 % |
| rnd-2jzte | Release fire suppression at UPS-A (T+3.5) | 47 | 32.9 | 0–47 | 70 % |
| rnd-582ixr | Release fire suppression at UPS-A (T+12.5) | 43 | 30.1 | 0–43 | 70 % |
| rnd-k2p9r | Release fire suppression at UPS-B (T+2) | 24 | 24.0 | 24–24 | 100 % |
| rnd-c5jdml | Restart CH-2 manually (T+13.5) | 24 | 6.8 | 0–24 | 12 % |
| rnd-5257ih | Restart CH-1 manually (T+6) | 0 | 2.7 | 0–48 | 90 % |
| rnd-68tlsd | Release fire suppression at UPS-A (T+6) | 43 | 31.0 | 0–43 | 72 % |
| rnd-2ri3zd | Reset the PDU-A1 main breaker (T+5) | 23 | 21.6 | 0–23 | 94 % |
| rnd-19ertc | Restart CH-2 manually (T+7) | 24 | 9.7 | 0–24 | 28 % |
| rnd-ea2fvd | Start GEN-1 manually (T+10.5) | 0 | 0.0 | 0–0 | 100 % |
| rnd-cu65ex | Restart CH-2 manually (T+5) | 48 | 22.9 | 0–48 | 24 % |
| rnd-69g8e9 | Restart CH-1 manually (T+2) | 0 | 0.0 | 0–0 | 100 % |
| rnd-77ugda | Close the isolation valves on PIPE-L2 (T+11) | 48 | 45.1 | 0–48 | 94 % |
| rnd-6n18yg | Cover CRAH-2 with the standby unit (T+4.5) | 20 | 19.3 | 4–20 | 94 % |
| rnd-bn16o5 | Release fire suppression at UPS-A (T+17) | 27 | 21.1 | 0–27 | 78 % |
| rnd-cjhfy2 | Close the isolation valves on PIPE-L2 (T+11) | 48 | 46.6 | 0–48 | 96 % |
| rnd-8fm3pz | Restart CH-2 manually (T+7) | 0 | 0.0 | 0–0 | 100 % |
| rnd-a4kt9u | Cover CRAH-4 with the standby unit (T+2.5) | 20 | 14.7 | 1–20 | 44 % |
| rnd-z4tnw | Restart CH-2 manually (T+5.5) | 48 | 29.3 | 0–48 | 38 % |
| rnd-dw4vly | Release fire suppression at UPS-A (T+4.5) | 43 | 28.7 | 0–47 | 14 % |
| rnd-5gmky2 | Isolate the leaking branch and top up CDU-1 (T+4) | 4 | 4.0 | 4–4 | 100 % |
| rnd-b8hg93 | Cover CRAH-1 with the standby unit (T+4) | 24 | 22.3 | 7–24 | 88 % |
| rnd-2lhyd7 | Start GEN-1 manually (T+19.5) | 24 | 18.8 | 0–24 | 42 % |
| rnd-3r506x | Restart CH-1 manually (T+2.5) | 48 | 33.0 | 0–48 | 40 % |
| rnd-79ngpc | Release fire suppression at UPS-A (T+5) | 47 | 32.9 | 0–47 | 70 % |
| rnd-3obmtc | Restart CH-1 manually (T+4) | 28 | 19.0 | 0–28 | 52 % |

Columns: *coverage* = share of realized losses inside the predicted p10–p90 (target ≈ 80 %); *p50 |error|* = mean absolute minutes between the realized loss and the predicted p50; *bias* > 0 means reality is slower than predicted; *missed* = realized losses the model did not predict within the horizon; *false alarms* = predicted losses that never happened.
