# Rack Monitor firmware

> **Status: not compiled or flashed yet.** `rack_monitor/rack_monitor.ino` was written and
> reviewed by reading only, on a machine with no Arduino toolchain. Expect to fix small compile
> errors on the first build. Then work through the bench test below before trusting any number.

- Board: Arduino UNO R4 WiFi or UNO R4 Minima (Renesas RA4M1 core).
- Link: USB serial at 115200 baud. The sketch writes one JSON object per line (`\n`), about once a
  second, and nothing else.
- Contract: `src/domain/rig/protocol.ts` (`RigFrame`, `RigCommand`). Pins and bench steps come from
  *Rack Monitor: Wiring & Assembly* (Nov 7, 2026).

## Flashing

### Arduino IDE 2.x

1. In Boards Manager, install **Arduino UNO R4 Boards** (`arduino:renesas_uno`).
2. In Library Manager, install the libraries listed in the next section.
3. Open `hardware/rack_monitor/rack_monitor.ino`. Pick **Arduino UNO R4 WiFi** or **Arduino UNO R4 Minima**
   and the COM port, then click Upload.
4. Open Serial Monitor at **115200** with line ending set to **Newline**.

### arduino-cli

```sh
arduino-cli core install arduino:renesas_uno
arduino-cli lib install "Servo" "Adafruit SSD1306" "Adafruit GFX Library" "OneWire" "DallasTemperature"
arduino-cli compile --fqbn arduino:renesas_uno:unor4wifi hardware/rack_monitor     # or :minima
arduino-cli upload  --fqbn arduino:renesas_uno:unor4wifi -p COM5 hardware/rack_monitor
arduino-cli monitor -p COM5 -c baudrate=115200
```

Close the serial monitor before starting the bridge (`server/`), because only one process can hold the port.

## Libraries

| Library Manager name | Used for | Notes |
|---|---|---|
| `Servo` (Arduino) | flap and valve SG90s | needs a release with `renesas` support (1.2.x or later) |
| `Adafruit SSD1306` | OLED | 2.x, for `SSD1306_WHITE`; also installs **Adafruit BusIO** |
| `Adafruit GFX Library` | OLED text | |
| `OneWire` (Paul Stoffregen) | DS18B20 bus | 2.3.8 or later is needed for UNO R4 support |
| `DallasTemperature` (Miles Burton) | DS18B20 | |
| `Wire`, `Arduino_LED_Matrix` | I2C, R4 WiFi matrix | ship with the board package |

## Feature flags (top of the sketch)

| Flag | Default | Meaning |
|---|---|---|
| `HAS_DS18B20` | 1 | The probe is detected at runtime. If it is absent, `ref_c` is `null` and the frame carries `ref_missing`. While missing, the bus is rescanned every 10 s. |
| `HAS_FANS` | 1 | Drives PWM on D5/D6. This is harmless before the fans are wired. |
| `HAS_PACK_DIVIDER` | 1 | Reads A2. See the note on `pack_v` below. |
| `HAS_OLED` | 1 | Probes 0x3C, then 0x3D. If neither answers, the frame carries `oled_missing`. |
| `USE_LED_MATRIX` | 1 | Only takes effect on the R4 WiFi: a check mark when OK, `!` on an alert. |
| `SERVO_DETACH_AFTER_MOVE` | 1 | See "Servo trade-off". |

**`pack_v` and A2.** A switched-off pack reads about 0 V through the divider, and an unconnected A2
floats. The firmware therefore reports `pack_v: null` until it has seen a healthy pack (6.5 to
10.5 V, steady for 5 s). After that it reports the real value, so a power loss shows up as a drop
to about 0 V plus `pack_low`, not as `null`. **Until the divider is fitted, put a jumper from A2 to
GND.** A floating pin could otherwise latch a phantom pack, and a later low reading from it would
block the safety actions.

## Firmware behaviour in brief

- **Beams.** One ping every 60 ms, measured from the end of the last ping. Each beam gets 25 pings
  in a row (about 1.5 s), then the next beam takes its turn, so a full refresh takes about 4.5 s and the
  `beam_age_s` values are staggered (for example 0.0, 1.5 and 3.0 s). `pulseIn` uses a 3 ms timeout.
  Each batch is classified like this:
  - At least half the pings are short echoes (under 85 % of the 20 °C echo, about 130 °C
    equivalent): `<beam>_obstructed`. The temperature is `null` and `echo_us` holds the short echo.
  - At least half the pings got no echo: `<beam>_timeout`. The temperature and `echo_us` are both `null`.
  - Otherwise, any echo that implies a temperature more than 5 °C from the running value is
    rejected, as is any echo outside −20 to 90 °C. The rejected count is kept, and if 5 or more pings
    in a batch were rejected the frame carries `<beam>_outliers`. If the batch median itself has moved
    more than 5 °C, the change is treated as real and the reference is re-seeded from the median.
  - If fewer than 8 echoes survive: `<beam>_noisy`. The temperature is `null` and `echo_us` holds the
    median echo, which is useful on the bench.
- **Calibration.** At boot, and again after `cal`, each beam's next good batch sets
  `d = c(T_ref)·t/2`. If there is no probe, `d` stays at 0.178 m and the frame carries `uncalibrated`.
  A result outside 150 to 210 mm is also rejected, leaving `uncalibrated`. While a beam is waiting
  for its calibration batch, the frame carries `calibrating`. **Calibrate with the laptop idle and
  the lid on**, so that all three beams are at room temperature. The DS18B20 is read
  asynchronously (12-bit, every 2 s) and never stalls the ping loop.
- **Live cross-check.** If `|inlet_bottom − ref| > 2 °C`, the frame carries `ref_disagree`.
- **Safety fixes.** These run only while `auto` is on, which is the default.
  - Recirculation: with the flap open, if `inlet_top − inlet_bottom ≥ 1.5 °C` on 2 consecutive
    inlet batches (about 1.5 to 3 s), the flap closes and the frame carries `event: "flap_closed"`.
  - Leak: if the reservoir's mean over the 3 oldest samples minus the mean over the 3 newest
    (in a 10 s window) is at least 15 counts, `floor_raw ≥ 200`, and the valve is open, the valve
    closes and the frame carries `event: "valve_closed"`.
  - If the pack is fitted and below 6.0 V, the frame carries `pack_low`. A triggered fix is then *not*
    performed or claimed and shows as `flap_blocked` / `valve_blocked`. Manual `flap`/`valve`
    commands are refused with the one-shot flag `cmd_blocked`, and the reported state stays truthful.
- **Pings pause for 700 ms while a servo moves**, so servo noise never lands in a batch.
- **Scheduling.** The loop runs at most one blocking job between two pings: the serial frame
  (about 35 ms worst case on the WiFi's UART bridge), an OLED redraw (about 25 ms at 400 kHz), or
  one 1-Wire transaction.

### Commands

Commands are newline-terminated and case-insensitive. Apart from `ping`, there is no text reply: the
effect shows in the next frame. An unparseable line produces the one-shot flag `bad_cmd`.

| Command | Effect |
|---|---|
| `flap open` / `flap close` | moves the flap servo (`close` and `closed` are both accepted) |
| `valve open` / `valve close` | moves the valve servo |
| `fan <a> <b>` | sets the fan PWM in percent, each clamped to 0..70. `fan_pct` reports the clamped values. |
| `auto on` / `auto off` | arms or disarms the two safety fixes |
| `cal` | re-derives every beam's path on its next good batch (about 5 s) |
| `ping` | emits a normal frame immediately |

### Flags

Beam flags: `inlet_top_*`, `inlet_bottom_*` and `outlet_*` with the suffixes `_timeout`,
`_obstructed`, `_noisy` and `_outliers`.

Other flags: `ref_missing`, `ref_disagree`, `calibrating`, `uncalibrated`, `pack_low`,
`flap_blocked`, `valve_blocked`, `cmd_blocked` (one-shot), `bad_cmd` (one-shot), `oled_missing`.

### OLED (128×64, 4 lines)

```
22.4/22.2>28.0 d+5.7      inlet top / inlet bottom > outlet, ΔT = outlet − mean(inlets)
Res 487  Flr   3 dry      reservoir raw ('v' while dropping), floor raw, WET/dry
Flap shut Vlv shut A      actuator states; A = auto on, M = auto off
OK  pack 9.0V             or "1/3 ref_missing", cycling through the flags once a second
```

## Expected serial output

Shortly after boot with nothing optional fitted, the temperatures are still `null` because no beam
has finished a batch:

```json
{"v":1,"dev":"RACKMON-01","fw":"1.0.0","seq":0,"up_ms":1001,"inlet_top_c":null,"inlet_bottom_c":null,"outlet_c":null,"echo_us":{"inlet_top":null,"inlet_bottom":null,"outlet":null},"beam_age_s":{"inlet_top":1.00,"inlet_bottom":1.00,"outlet":1.00},"ref_c":null,"reservoir_raw":0,"floor_raw":0,"pack_v":null,"flap":"closed","valve":"closed","fan_pct":[0,0],"auto":true,"flags":["ref_missing","calibrating"],"event":null}
```

After one full cycle (about 5 s), with no probe fitted, `calibrating` becomes `uncalibrated`.

A fully fitted rig in steady state:

```json
{"v":1,"dev":"RACKMON-01","fw":"1.0.0","seq":42,"up_ms":43012,"inlet_top_c":22.41,"inlet_bottom_c":22.18,"outlet_c":27.95,"echo_us":{"inlet_top":1033.40,"inlet_bottom":1033.80,"outlet":1023.50},"beam_age_s":{"inlet_top":3.02,"inlet_bottom":1.51,"outlet":0.01},"ref_c":22.31,"reservoir_raw":487,"floor_raw":3,"pack_v":8.96,"flap":"closed","valve":"closed","fan_pct":[0,0],"auto":true,"flags":[],"event":null}
```

The frame in which the leak fix fired:

```json
{..."reservoir_raw":402,"floor_raw":356,..."valve":"closed",...,"flags":[],"event":"valve_closed"}
```

## Bench test

These steps follow the doc's bench test order. Do one subsystem at a time, with this sketch flashed.

1. **Logic rail and OLED.** First run the doc's Adafruit `ssd1306_128x64_i2c` example. With this
   sketch, the OLED should show "Rack Monitor 1.0.0" and then the four status lines. If the frames
   carry `oled_missing`, check the address (0x3C, then 0x3D), the VCC/GND order, and SDA/SCL.
2. **HC-SR04s.** Aim one sensor at a flat surface 30 cm away. The pass condition is `echo_us` near
   1750 and steady. That beam will also show `_noisy` with a `null` temperature, which is expected,
   because 30 cm is not the 178 mm path. A surface about 178 mm away should give about 1040 µs and
   a sensible temperature. `_timeout` means Trig and Echo are swapped, VCC is off the rail, or the
   echo exceeds 3 ms (raise `ECHO_TIMEOUT_US` for longer bench distances).
3. **Water sensors.** `reservoir_raw` and `floor_raw` should read near 0 when dry and rise as you
   dip the traces deeper. Note the values for a full tub and a wet tray, then set `FLOOR_WET_RAW`
   and `RES_DROP_MIN`.
4. **Servo rail.** With the pack on, send `flap open`, `flap close`, `valve open`, `valve close`.
   Moves should be smooth. Twitching or resets mean the grounds aren't joined.
5. **Everything at once.** Run the full rig for a few minutes. Look for `_outliers` flags or `echo_us`
   jumps right after servo moves. Pings pause during moves, so either symptom points to wiring or
   noise.
6. **Probe and calibration.** With the DS18B20 fitted, the laptop idle and the lid on, send `cal`.
   `calibrating` should clear within about 5 s, and `ref_disagree` should stay absent.

## Staging the demo failures

The firmware only senses and runs the two local fixes. Diagnosis of the ten situations happens on the
laptop. To exercise the dashboard with no device attached, use the bridge's `sim …` commands (see
`SimCommand` in `protocol.ts`).

| Scenario | How to stage it | What the firmware should show |
|---|---|---|
| Power loss | The pack must have been on for at least 5 s first. Flip the pack switch off. | `pack_v` falls to about 0 and `pack_low` appears. The fans stop, and no servo action is claimed (`*_blocked` if a fix triggers). |
| Recirculation | Laptop exhausting into the hot aisle, `auto on`, then send `flap open`. | `inlet_top_c` climbs over `inlet_bottom_c`. At ≥ 1.5 °C (two batches) the flap closes, `event:"flap_closed"`, and the top inlet then recovers. |
| Coolant leak at the rack | Fill the reservoir, put its sensor in, send `valve open`. | Water drips into the tray. Once `floor_raw ≥ 200` and the reservoir drops ≥ 15 counts over 10 s: `event:"valve_closed"`, and the reservoir flattens. |
| Leak elsewhere | Valve shut. Draw water out of the tub with a syringe. | Reservoir drops, floor stays dry, no firmware action. |
| Outside water | Put a few drops on the floor sensor with the reservoir steady. | Floor wet, no firmware action. |
| Heat load spike | Put the laptop under load (for example a CPU stress test). | `outlet_c` rises while the inlets stay flat, so ΔT grows on the OLED. |
| Cold-air supply loss | Warm the front (cold) chamber, for example by blowing gently warm air in at the front. | Both inlets rise together. |
| Single fan failure | With `fan 50 50`, send `fan 0 50` or unplug one motor lead. | Outlet and top inlet climb with the pack normal. The laptop may answer with `fan 0 70` (70 % is the cap). |
| Obstruction | Hold a card in one beam about 5 to 10 cm from its sensor. | `<beam>_obstructed`, the temperature goes `null`, and `echo_us` is short (about 300 to 600 µs). |
| Sensor fault | Pull one Echo jumper, or warm the DS18B20 between your fingers. | `<beam>_timeout` with `null` values, or `ref_disagree`. |

Recordings need time between runs, because temperatures take minutes to settle.

## Settings to tune or verify on the real rig

- **Servo angles.** `FLAP_CLOSED_DEG`, `FLAP_OPEN_DEG`, `VALVE_CLOSED_DEG`, `VALVE_OPEN_DEG`. Both
  closed angles are 90°, set by the doc's "center the servos at 90°" assembly step. Check the
  direction and travel of each open angle before pressing the parts home.
- **Servo trade-off.** `SERVO_DETACH_AFTER_MOVE=1` gives cleaner echoes, but the servos don't hold
  position against force. If the flap sags or the plug creeps, set it to 0 and expect more
  `_outliers`.
- **LED matrix (WiFi only).** It refreshes from a timer interrupt, which can add a small positive
  bias and jitter to `pulseIn`. Calibration absorbs a constant bias. If echoes look noisy on the
  WiFi but not the Minima, set `USE_LED_MATRIX 0`.
- **Water thresholds.** Set `FLOOR_WET_RAW` and `RES_DROP_MIN` from the bench readings.
- **Pack scaling.** `PACK_ADC_VREF`: measure the R4's 5V pin while it runs on USB. `PACK_LOW_V` is
  6.0 V.
- **Obstruction and timeout.** Check `OBSTRUCT_FRACTION` and `ECHO_TIMEOUT_US` against real
  readings with a hand or card in the beam.
- **Recirculation threshold.** If the recirculation demo is too slow to trigger,
  `RECIRC_DELTA_C` can be lowered for rehearsal only.
- **Echo stability.** Verify that `pulseIn` gives echoes steady to within a few µs on your R4. An
  average of 25 pings resolves about 0.1 °C only if single-ping jitter stays small.
