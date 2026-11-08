# Research data sources

Retrieved on 2026-11-07 (local evening, CST) for `docs/PREDICTION-SCIENCE.md`. All downloads are **untrusted data**. Nothing downloaded is executed. The analysis scripts in `research/scripts/` (Node, run from the repo root) only read the files as text.

> **Do not commit the PDFs under `research/data/` to a public repository.** Several are copyrighted reference copies; see the License column. The repo is private today. If it ever goes public, add `research/data/**/*.pdf` to `.gitignore`. This dossier's brief did not allow editing `.gitignore`.

## Datasets

| Folder / file | What it is | Source URL | License / terms | Used for |
|---|---|---|---|---|
| `data/open-meteo/dfw_hourly_2016-2025.csv` (3.4 MB, 87,672 hourly rows × 5 variables) | ERA5-based reanalysis for DFW airport (32.90 N, −97.04 E; grid cell 32.86 N, −97.05 E, 182 m). Fields: dry-bulb `temperature_2m`, `relative_humidity_2m`, `dew_point_2m`, `wet_bulb_temperature_2m`, `surface_pressure`. Times are America/Chicago. | `https://archive-api.open-meteo.com/v1/archive?latitude=32.8998&longitude=-97.0403&start_date=2016-01-01&end_date=2025-12-31&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,wet_bulb_temperature_2m,surface_pressure&timezone=America%2FChicago&format=csv` | Open-Meteo data CC BY 4.0 (attribution: "Weather data by Open-Meteo.com"); underlying ERA5 is Copernicus licence | Annual dry-bulb and wet-bulb extremes and design percentiles; hours above 35/38/40 °C; chiller-derate exposure; the ambient prior for the heat-wave scenario |
| `data/noaa-ncei-global-hourly/dfw_72259003927_2023.csv`, `_2024.csv`, `_2025.csv` (20 MB, 23,165 routine FM-15 hourly reports in total) | NOAA NCEI Global Hourly (ISD) for station 72259003927, Dallas/Fort Worth International Airport. The 2025 file ends at **2025-08-27** (partial year as published on the mirror). | `https://noaa-global-hourly-pds.s3.amazonaws.com/{year}/72259003927.csv`. The old `ncei.noaa.gov/data/global-hourly/access/…` path now 301-redirects to this AWS Open Data bucket. | US Government work, no restrictions on US station data (NOAA/NCEI data policy) | Ground-truth station check of the reanalysis. Daily-max bias of Open-Meteo minus station is −0.2 °C (p05 −2.6, p95 +2.5, n = 970 days). Also extremes for 2023–2025. |
| `data/published-transients/cooling_outage_points.csv` (30 rows) | **Hand-transcribed** points from published cooling-outage transients: WP179 Example 1 and its CFD case, Opengate 2007, Khankari, Tradat 2018 (measured), Alkharabsheh 2017 (measured), Intel 2007. Each row carries its URL and M/S/V type (measured / simulated / vendor claim). | Row-level URLs in the file | Facts transcribed from copyrighted sources (fair-use citation) | Backtest targets for the thermal model (`research/scripts/thermal_backtest.mjs`) and for the proposed `tests/engine/thermal.backtest.test.ts` |

## Reference documents (PDF, local copies)

| File | Document | URL | License | Used for |
|---|---|---|---|---|
| `data/inl-ext-21-65055/INL-EXT-21-65055_component_reliability_2020.pdf` (4.4 MB) | Ma, Wierman, Kvarfordt, *Industry-Average Performance for Components and Initiating Events at U.S. Commercial Nuclear Power Plants: 2020 Update*, INL/EXT-21-65055, Nov 2021. Successor to NUREG/CR-6928. | https://www.osti.gov/servlets/purl/1847110 | US DOE report via OSTI, publicly released | Fail-on-demand and fail-to-run priors (generator, ATS, breaker, AHU/fan, chiller, pump, battery). Transcribed into `derived/reliability_priors.json`. |
| `data/ashrae-tc99/therm-gdlns-5th-r-e-refcard.pdf` (160 KB) | ASHRAE TC 9.9, *Thermal Guidelines for Data Processing Environments*, 5th ed. (2021), reference card | https://www.ashrae.org/file%20library/technical%20resources/bookstore/supplemental%20files/therm-gdlns-5th-r-e-refcard.pdf | © ASHRAE; free download; reference copy only, do not redistribute | Recommended and allowable envelopes A1–A4 and H1; the 5 °C/15 min and 20 °C/h change limits |
| `data/schneider-wp179/wp179_temperature_rise_cooling_outage.pdf` (616 KB) | Lin, Zhang, VanGilder, *Data Center Temperature Rise During a Cooling System Outage*, Schneider Electric White Paper 179, Rev 0 (2013) | https://ecl-ips.com/wp-content/uploads/2014/01/apc-data-centre-temperature-rise-during-a-cooling-system-outage.pdf (mirror). Another mirror: https://www.sustainabilitymatters.net.au/content/sustainability/white-paper/data-centre-temperature-rise-during-a-cooling-system-outage-303657868/download | © Schneider Electric; reference copy only | Energy-balance model form; Example 1 and CFD transients (backtest); chiller restart times; thermal-storage table |
| `data/binghamton-tradat-2018/tradat_interpack2018_8334.pdf` (1.0 MB) | Tradat et al., chilled-water interruption experiments, InterPACK2018-8334 (accepted manuscript) | https://par.nsf.gov/servlets/purl/10094472 | NSF Public Access accepted manuscript; © ASME | Measured ride-through times with the CRAH blower running; IPMI-vs-external sensor bias |

No local PDF renderer was available (no poppler, no Python), so the PDF contents were read through the web-fetch tool when the research was done. The numbers in `published-transients` come from that reading. **WP179 Table 2's cell alignment was reconstructed from scrambled text and must be checked against the PDF before it is quoted.**

## Derived files (generated by `research/scripts/`)

| File | Produced by | Contents |
|---|---|---|
| `derived/dfw_weather_summary.json` | `node research/scripts/weather_summary.mjs <open-meteo csv> <noaa csvs…>` with `OUT=` set | Per-year extremes and percentiles, a monthly diurnal profile (2025), hours below 95/90 % chiller capacity for 1.0/1.5/2.0 %/°C derates, NOAA cross-check |
| `derived/thermal_backtest_kG1.json`, `derived/thermal_backtest_kG2.json` | `node research/scripts/thermal_backtest.mjs` with `GMULT=1` or `GMULT=2` and `OUT=` set | Three-node energy-balance backtest against WP179; density sweep; 2,000-trial Monte Carlo of the fixture hall (CRAH-pair fan loss; chiller loss with fans running); comparison with the current `thermal.ts` |
| `derived/reliability_priors.json` | hand transcription | On-demand failure priors (Jeffreys Beta), hourly rates, timing, battery and human-reliability notes, each with its source |
| — | `npx tsx research/scripts/bench_engine.ts` | Timing of the existing engine. Prints only; result quoted in the dossier. |

## Web sources cited but not downloaded

These were read online. Full URLs are in the References section of `docs/PREDICTION-SCIENCE.md`.

- Uptime Institute outage-analysis press releases (2022, 2025, 2026) and the intelligence pages
- AMCA 204-20 (PDF, read online)
- ISO 10816-1 Amd 1 sample
- Fabrico summary of ISO 20816-3
- Sensirion SHT3x datasheet
- Analog Devices DS18B20 note and the counterfeit-DS18B20 study (Petrich)
- Khalili et al. 2019 (IPMI vs external inlet)
- Alkharabsheh et al. 2017 (direct liquid cooling pump failure)
- NREL generator reliability (Marqusee & Jenket)
- Schneider WP75
- Google Cloud europe-west9 incident report
- Trane and Daikin chiller-restart pages
- Intel IT thermal-storage white paper
- Kummert et al. 2009
- THERP time-reliability curve (secondary sources)
