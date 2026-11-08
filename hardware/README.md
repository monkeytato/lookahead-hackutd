# Rack Monitor firmware (v2: four sensors)

> **Status: not compiled or flashed yet.** `rack_monitor/rack_monitor.ino` was written and
> reviewed by reading only, on a machine with no Arduino toolchain. Expect to fix small compile
> errors on the first build. Then work through the bench test below before trusting any number.

- Board: Arduino UNO R4 WiFi or UNO R4 Minima (Renesas RA4M1 core).
- Link: USB serial at 115200 baud. The sketch writes one JSON object per line (`\n`), about once a
  second, and nothing else.
- Contract: `src/domain/rig/protocol.ts` (`RigFrame` v2, `RigCommand`).

## The four sensors

| Sensor | Pins | Measures | Feeds |
|---|---|---|---|
| DS18B20 temperature probe | D11 data, 5.1 kΩ pull-up to 5 V | Front-inlet air temperature, 12-bit, every 2 s | Recirculation, cold-supply loss, time-to-limit |
| HC-SR04 ultrasonic × 2 | fan A: D2 trig / D4 echo · fan B: D7 trig / D8 echo | **Vibration**: distance to each exhaust fan's mount, ~16 pings/s each, wobble over a ~3.8 s window | Fan vibration trend, stopped fan, blocked sensor |
| Water level sensor | A0 (signal), + to logic 5 V, − to GND | Drips in the tray under the coolant line, raw 0–1023 | Coolant leak, outside water |

Also read: 6×AA pack voltage through a 10 k/10 k divider on A2 (`V = 2 · V_A2`). Actuators: flap servo
D9, valve servo D10, fans on L298N ENA/ENB from D5/D6. OLED on SDA/SCL.

Pin changes from the earlier three-beam build: the outlet HC-SR04 (D13/D12) and the reservoir water
sensor (A1) are gone. Mount the two HC-SR04s on the back wall, each ~40 mm from its fan's gearbox
cradle, aimed squarely at the flat face of the mount. Mount the DS18B20 in the pocket by the front
inlet. Lay the water sensor flat in the drip tray under the reservoir's leak hole, traces up.

### How the vibration reading works

A running fan shakes its mount; the HC-SR04 sees that as the distance wobbling around a mean. Each
sensor is pinged every 60 ms. Over 64 pings the firmware takes the median, rejects single pings more
than 6 mm off, removes a linear drift, and reports:

- `dist_mm` mean distance; `disp_mm` RMS wobble; `p2p_mm` peak-to-peak;
- `freq_hz` an **apparent** frequency from zero crossings. At ~16 pings/s the Nyquist limit is ~8 Hz,
  so a 25 Hz shaft rate aliases: treat this as a texture number, not the shaft speed;
- `vel_mm_s = 2π · freq_hz · disp_mm`, an **indicative** velocity so trends can be read on the same
  axis as ISO 10816 charts. It is not an ISO contact measurement. The dashboard says so.

Expect roughly: healthy fan ~1–2 mm/s indicative; tape on a blade ~3–6; a loose mount or a bump
above ~7. **Those are the simulator's assumptions; the bench sets the real numbers and the
`VIB_WARN_MM_S` / `VIB_ALARM_MM_S` thresholds in `src/domain/rig/diagnose.ts`.**

## Flashing

### Arduino IDE 2.x

1. In Boards Manager, install **Arduino UNO R4 Boards** (`arduino:renesas_uno`).
2. In Library Manager, install the libraries listed below.
3. Open `hardware/rack_monitor/rack_monitor.ino`. Pick **Arduino UNO R4 WiFi** or **UNO R4 Minima**
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
| `Adafruit SSD1306` | OLED | 2.x; also installs **Adafruit BusIO** |
| `Adafruit GFX Library` | OLED text | |
| `OneWire` (Paul Stoffregen) | DS18B20 bus | 2.3.8 or later for UNO R4 |
| `DallasTemperature` (Miles Burton) | DS18B20 | |
| `Wire`, `Arduino_LED_Matrix` | I2C, R4 WiFi matrix | ship with the board package |

## Feature flags (top of the sketch)

| Flag | Default | Meaning |
|---|---|---|
| `HAS_DS18B20` | 1 | Probe detected at runtime. Absent: `temp_c` is `null` and the frame carries `temp_missing`; the bus is rescanned every 10 s. |
| `HAS_FANS` | 1 | PWM on D5/D6. Harmless before the fans are wired. |
| `HAS_PACK_DIVIDER` | 1 | Reads A2. `pack_v` stays `null` until a healthy pack (6.5–10.5 V, steady 5 s) is seen; **jumper A2 to GND until the divider is fitted.** |
| `HAS_OLED` | 1 | Probes 0x3C then 0x3D; `oled_missing` if neither answers. |
| `USE_LED_MATRIX` | 1 | R4 WiFi only: check mark when OK, `!` on an alert. |
| `SERVO_DETACH_AFTER_MOVE` | 1 | Cleaner pings; servos don't hold against force. |

## Firmware behaviour in brief

- **Probe.** One 12-bit reading every 2 s, converted asynchronously. The first valid reading (above
  10 °C) becomes the **baseline**; `cal` resets it. Until then the frame carries `uncalibrated`. A
  reading outside −55…125 °C sets `temp_invalid`; three in a row drop the probe to `temp_missing`.
- **Vibration.** The two sensors alternate, one ping every 30 ms. A window is 64 pings per sensor.
  More than half obstructed (< 15 mm) → `<fan>_obstructed`; more than half timeouts or beyond
  300 mm → `<fan>_timeout`; fewer than 24 accepted pings → `<fan>_noisy`. All three make the
  channel's numbers `null`.
- **Safety fixes** (only while `auto` is on, the default):
  - Recirculation: with the flap open, if the inlet reads ≥ 1.5 °C above baseline on 2 consecutive
    probe readings (~4 s), the flap closes and the frame carries `event: "flap_closed"`.
  - Leak: if `drip_raw ≥ 120` while the valve is open, the valve closes: `event: "valve_closed"`.
  - If the pack is fitted and below 6.0 V, a triggered fix is *not* performed or claimed and shows as
    `flap_blocked` / `valve_blocked`. Manual `flap`/`valve` commands are refused with `cmd_blocked`.
- **Pings pause for 700 ms while a servo moves**, so servo noise never lands in a window.
- **Scheduling.** At most one blocking job between two pings: the serial frame, an OLED redraw, or one
  1-Wire transaction.

### Commands

| Command | Effect |
|---|---|
| `flap open` / `flap close` | moves the flap servo |
| `valve open` / `valve close` | moves the valve servo |
| `fan <a> <b>` | fan PWM in percent, each clamped to 0..70 |
| `auto on` / `auto off` | arms or disarms the two safety fixes |
| `cal` | baseline = current inlet reading; records each sensor's mean distance. Do it with the flap shut, fans on, laptop idle |
| `ping` | emits a frame immediately |

### Flags

`fan_a_timeout`, `fan_a_obstructed`, `fan_a_noisy` (and `fan_b_…`), `temp_missing`, `temp_invalid`,
`uncalibrated`, `pack_low`, `flap_blocked`, `valve_blocked`, `cmd_blocked` (one-shot), `bad_cmd`
(one-shot), `oled_missing`.

### OLED (128×64, 4 lines)

```
In 22.4C  d+0.1          inlet temperature and rise over baseline
Vib A1.6 B1.7 mm/s       indicative velocity per fan
Tray   3 dry Fsh Vsh A   drip raw, wet/dry, flap, valve, A = auto on / M = off
OK  pack 9.0V            or "1/3 temp_missing", cycling through the flags
```

## Expected serial output

Steady state, everything fitted:

```json
{"v":2,"dev":"RACKMON-01","fw":"2.0.0","seq":42,"up_ms":43012,"temp_c":22.3750,
 "vib":{"fan_a":{"dist_mm":41.8,"disp_mm":0.011,"p2p_mm":0.031,"freq_hz":6.2,"vel_mm_s":0.43,"n":61},
        "fan_b":{"dist_mm":42.3,"disp_mm":0.012,"p2p_mm":0.034,"freq_hz":5.9,"vel_mm_s":0.44,"n":62}},
 "drip_raw":3,"pack_v":8.96,"flap":"closed","valve":"closed","fan_pct":[70,70],"auto":true,"flags":[],"event":null}
```

The frame in which the leak fix fired: `"drip_raw":356,…,"valve":"closed",…,"event":"valve_closed"`.

## Bench test

1. **Logic rail and OLED.** Run the Adafruit `ssd1306_128x64_i2c` example first. With this sketch the
   OLED shows "Rack Monitor 2.0.0" and then the four lines.
2. **Probe.** With the DS18B20 fitted, `temp_c` should appear within ~3 s and move when you warm the
   probe between your fingers. `temp_missing` means data/pull-up are wrong.
3. **Ultrasonic distance.** Aim one sensor at a flat surface ~40 mm away. `dist_mm` should read ~40 and
   `disp_mm` under ~0.05 with nothing moving. `_timeout` means Trig/Echo swapped or VCC off the rail.
   Hold a card 5 mm in front: `_obstructed`.
4. **Vibration.** Fans on at `fan 70 70`. Note `vel_mm_s` for each fan; that's your healthy baseline.
   Put a small piece of tape on one blade: that fan's `disp_mm` and `vel_mm_s` should rise several
   times over. Set `VIB_WARN_MM_S` / `VIB_ALARM_MM_S` from what you see.
5. **Drip tray.** `drip_raw` near 0 dry; put a few drops on the traces and it should climb past 120.
   Set `DRIP_WET_RAW` from a wet reading.
6. **Servo rail.** Pack on: `flap open`, `flap close`, `valve open`, `valve close`. Twitching or resets
   mean the grounds aren't joined.
7. **Everything together.** Run for a few minutes and watch for `_noisy` right after servo moves.
8. **Calibrate.** Flap shut, fans on, laptop idle: send `cal`. `uncalibrated` should clear.

## Staging the demo failures

| Scenario | How to stage it | What the firmware should show |
|---|---|---|
| Power loss | Pack on ≥ 5 s, then flip it off | `pack_v` ~0, `pack_low`, fans stop, both vibration channels go still |
| Recirculation | Laptop exhausting into the hot aisle, `auto on`, `flap open` | `temp_c` climbs; at ≥ 1.5 °C over baseline for two readings the flap closes, `event:"flap_closed"` |
| Coolant leak | Fill the reservoir, `valve open` | Drips reach the tray; once `drip_raw ≥ 120` the valve closes, `event:"valve_closed"` |
| Outside water | Valve shut; drop water on the tray sensor | `drip_raw` rises, no firmware action (bridge routes to facilities) |
| Fan imbalance | Tape on one fan blade | That fan's `disp_mm` / `vel_mm_s` rise; the other stays |
| Loose mount | Loosen one fan cradle's snap | Larger rise, lower apparent frequency |
| Single fan failure | `fan 0 70` or unplug a lead | That channel's `disp_mm` collapses, pack rises slightly |
| Cold-supply loss | Warm the front chamber gently | `temp_c` rises with the flap shut |
| Blocked sensor | Card in front of one HC-SR04 | `<fan>_obstructed`, channel null |
| Sensor fault | Pull the probe's data lead | `temp_invalid` then `temp_missing` |

## Settings to tune or verify on the real rig

- **Servo angles** `FLAP_*_DEG`, `VALVE_*_DEG`.
- **Vibration**: `PING_GAP_MS` (30 ms assumes short echoes at 40 mm; raise it if `_noisy` appears),
  `OBSTRUCT_MM`, `JUMP_MM`, and the dashboard's `VIB_WARN_MM_S` / `VIB_ALARM_MM_S`.
- **Water** `DRIP_WET_RAW`. **Pack** `PACK_ADC_VREF`. **Recirculation** `RECIRC_DELTA_C`.
- **Echo stability**: the LED matrix's timer interrupt can add jitter to `pulseIn`; set
  `USE_LED_MATRIX 0` if `disp_mm` on a still mount won't settle below ~0.05 mm.
