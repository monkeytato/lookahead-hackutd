// ============================================================================
//  Rack Monitor firmware  --  hardware/rack_monitor/rack_monitor.ino
//
//  Board : Arduino UNO R4 WiFi or UNO R4 Minima (Renesas RA4M1 core)
//  Link  : USB serial, 115200 baud, one JSON object (RigFrame) per line, ~1 Hz
//  Spec  : src/domain/rig/protocol.ts (authoritative frame/command format)
//          "Rack Monitor -- Wiring & Assembly" (Nov 7, 2026) (authoritative pins)
//
//  STATUS: written without a toolchain -- NOT YET COMPILED OR FLASHED.
//
//  What it does
//    * Three HC-SR04 beams measure air temperature from the speed of sound:
//        c = 2d / t,   T = 273.15 * ((c / 331.3)^2 - 1)
//      Beams take turns (25 pings each, 60 ms apart => ~1.5 s per beam,
//      ~4.5 s for all three). Each batch is sanity-checked (timeouts,
//      obstruction, single-echo outliers) before it updates the beam.
//    * DS18B20 reference probe (optional) calibrates each beam's path length
//      at startup / on "cal", and is cross-checked live against inlet_bottom.
//    * Two on-device safety fixes (when auto is on): recirculation -> close
//      flap; coolant leak -> close valve. Refused (and flagged) when the pack
//      is known to be low, because the servos run off the pack.
//    * OLED status (4 lines) and, on the R4 WiFi, the LED matrix.
// ============================================================================

#include <Arduino.h>
#include <Wire.h>
#include <Servo.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

// ---------------------------------------------------------------- feature flags
// Parts that arrive later are compiled in by default and detected at runtime.
// Set a flag to 0 to remove the code path entirely.
#ifndef HAS_DS18B20
#define HAS_DS18B20 1        // DS18B20 on D11 (5.1k pull-up). Absent => ref_c null + "ref_missing"
#endif
#ifndef HAS_FANS
#define HAS_FANS 1           // L298N ENA/ENB on D5/D6. Harmless if not wired yet.
#endif
#ifndef HAS_PACK_DIVIDER
#define HAS_PACK_DIVIDER 1   // 10k/10k divider on A2. Absent => pack_v null (see packFitted).
#endif
#ifndef HAS_OLED
#define HAS_OLED 1           // SSD1306 128x64 on I2C 0x3C (fallback 0x3D)
#endif
#ifndef USE_LED_MATRIX
#define USE_LED_MATRIX 1     // R4 WiFi only; ignored on the Minima
#endif
#ifndef SERVO_DETACH_AFTER_MOVE
// 1: detach each servo SERVO_SETTLE_MS after a move. Stops the Servo timer ISR
//    and the 50 Hz pulse train, which otherwise add jitter to pulseIn() echo
//    timing. SG90 gear friction holds the light flap / valve arm unpowered.
// 0: keep the servos attached and holding. Use this if the flap sags or the
//    valve plug creeps out of the hole; expect noisier echoes (more outliers).
#define SERVO_DETACH_AFTER_MOVE 1
#endif

#if HAS_OLED
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#endif

#if HAS_DS18B20
#include <OneWire.h>
#include <DallasTemperature.h>
#endif

#if USE_LED_MATRIX && defined(ARDUINO_UNOR4_WIFI)
#include <Arduino_LED_Matrix.h>
#define LED_MATRIX_ENABLED 1
#else
#define LED_MATRIX_ENABLED 0
#endif

// ---------------------------------------------------------------- identity
#define RM_DEVICE_ID  "RACKMON-01"
#define RM_FW_VERSION "1.0.0"

// ---------------------------------------------------------------- pins (wiring doc)
enum { BEAM_TOP = 0, BEAM_BOTTOM = 1, BEAM_OUTLET = 2, NUM_BEAMS = 3 };
const uint8_t P_TRIG[NUM_BEAMS] = { 2, 7, 13 };   // inlet top, inlet bottom, outlet
const uint8_t P_ECHO[NUM_BEAMS] = { 4, 8, 12 };
const char* const BEAM_NAME[NUM_BEAMS] = { "inlet_top", "inlet_bottom", "outlet" };

const uint8_t P_RESERVOIR = A0;   // water sensor in the reservoir tub
const uint8_t P_FLOOR     = A1;   // water sensor in the drip tray
const uint8_t P_PACK      = A2;   // pack divider midpoint (V_pack = 2 * V_A2)
const uint8_t P_FAN_A     = 5;    // L298N ENA
const uint8_t P_FAN_B     = 6;    // L298N ENB
const uint8_t P_FLAP      = 9;    // flap servo signal
const uint8_t P_VALVE     = 10;   // valve servo signal
const uint8_t P_ONEWIRE   = 11;   // DS18B20 data

// ---------------------------------------------------------------- servo angles
// TUNE AFTER ASSEMBLY. The doc's assembly step 1 centres both servos at 90 deg
// before the horns go on, and the flap horn is pressed on with the flap
// standing up (closed), the valve arm with the plug seated in the leak hole
// (closed). So "closed" = 90 deg for both; "open" is a swing away from that.
// If a part swings the wrong way, mirror the open angle around 90
// (e.g. 180 -> 0, 135 -> 45). Keep clear of the 0/180 end stops if the part
// hits the lid / divider before the servo reaches the angle.
const int FLAP_CLOSED_DEG  = 90;
const int FLAP_OPEN_DEG    = 180;   // flap lying back (gap over the divider open)
const int VALVE_CLOSED_DEG = 90;
const int VALVE_OPEN_DEG   = 135;   // plug swung out of the leak hole
const uint32_t SERVO_SETTLE_MS = 700;   // time to finish a move; pings pause meanwhile

// ---------------------------------------------------------------- acoustic constants
const float    DEFAULT_PATH_M    = 0.178f;  // one-way beam path from the CAD
const uint8_t  PINGS_PER_BEAM    = 25;      // pings averaged per beam update
const uint32_t PING_GAP_MS       = 60;      // between any two pings (sensors must not hear each other)
const unsigned long ECHO_TIMEOUT_US = 3000; // ~1040 us expected; covers the HC-SR04 lead-in too
const float    MAX_JUMP_C        = 5.0f;    // single echo implying a bigger jump = outlier
const float    T_MIN_C           = -20.0f;  // plausible air temperature window per echo
const float    T_MAX_C           = 90.0f;
const float    OBSTRUCT_FRACTION = 0.85f;   // echo < 85 % of the 20 C echo (~130 C equivalent) = obstruction
const uint8_t  MIN_GOOD_PINGS    = 8;       // fewer accepted pings than this => batch untrusted
const uint8_t  OUTLIER_FLAG_MIN  = 5;       // rejected pings in one batch that raise "<beam>_outliers"
const float    CAL_WINDOW_US     = 10.0f;   // calibration uses echoes within +-10 us of the median
const float    CAL_PATH_MIN_M    = 0.150f;  // calibrated path outside this => keep 0.178 m, "uncalibrated"
const float    CAL_PATH_MAX_M    = 0.210f;
const float    REF_DISAGREE_C    = 2.0f;    // |inlet_bottom - ref| above this => "ref_disagree"

// ---------------------------------------------------------------- DS18B20 timing
const uint32_t REF_PERIOD_MS     = 2000;    // one reading every 2 s
const uint32_t REF_CONVERSION_MS = 800;     // 12-bit conversion is 750 ms (async, never blocks)
const uint32_t REF_RESCAN_MS     = 10000;   // look for a probe again every 10 s while missing

// ---------------------------------------------------------------- water / pack / safety
const uint16_t FLOOR_WET_RAW    = 200;    // TUNE: floor sensor above this = wet (dry reads ~0)
const int      RES_DROP_MIN     = 15;     // TUNE: reservoir must fall by this many counts over ~10 s
const uint8_t  RES_HIST_LEN     = 11;     // 1 Hz samples => 10 s window
const float    RECIRC_DELTA_C   = 1.5f;   // inlet_top - inlet_bottom at/above this => recirculation
const uint8_t  RECIRC_CONFIRM   = 2;      // consecutive fresh inlet batches that must agree
const float    PACK_ADC_VREF    = 5.0f;   // TUNE: measure the R4's 5V pin on USB (often 4.7-5.0 V)
const float    PACK_DIVIDER     = 2.0f;   // 10k / 10k
const float    PACK_LOW_V       = 6.0f;   // below this the servos cannot be trusted to move
const float    PACK_DETECT_MIN_V = 6.5f;  // a healthy pack must read in this window ...
const float    PACK_DETECT_MAX_V = 10.5f;
const uint8_t  PACK_DETECT_SAMPLES = 5;   // ... steadily for 5 s before the divider counts as fitted
const int      FAN_MAX_PCT      = 70;     // TT motors are 3-6 V on a 9 V pack

// ---------------------------------------------------------------- scheduling
const uint32_t FRAME_PERIOD_MS  = 1000;
const uint32_t SAMPLE_PERIOD_MS = 1000;   // water + pack sampling and leak check
const uint32_t OLED_PERIOD_MS   = 1000;
const uint32_t OLED_PHASE_MS    = 500;    // redraw half-way between frames
const uint32_t ACTION_ALERT_MS  = 10000;  // LED matrix shows "!" this long after a safety action

// ---------------------------------------------------------------- types
enum BeamStatus { BS_NONE = 0, BS_OK, BS_TIMEOUT, BS_OBSTRUCTED, BS_NOISY };   // stored as uint8_t

struct Beam {
  float    pathM;          // one-way path length used in c = 2d/t
  bool     calibrated;     // pathM came from the reference probe
  bool     calPending;     // next good batch re-derives pathM
  float    tempC;          // NAN = null in the frame
  float    echoUs;         // NAN = null in the frame
  float    runningC;       // last accepted temperature, reference for outlier rejection
  uint32_t lastFreshMs;    // millis() of last good batch (0 = never)
  uint8_t  status;         // BeamStatus of the last batch
  uint8_t  lastRejected;   // outliers rejected in the last batch
  uint32_t outliersTotal;  // since boot (not in the frame; shown via "<beam>_outliers")
};

struct Actuator {
  Servo    servo;
  uint8_t  pin;
  int      openDeg;
  int      closedDeg;
  bool     isOpen;
  bool     attached;
  bool     settling;
  uint32_t settleUntil;
};

// ---------------------------------------------------------------- globals
Beam beams[NUM_BEAMS];
uint16_t samples[PINGS_PER_BEAM];
uint8_t  sampleCount = 0;
uint8_t  curBeam = BEAM_TOP;
uint32_t lastPingMs = 0;
uint32_t pingPauseUntil = 0;

Actuator flap;
Actuator valve;

bool    autoMode = true;           // safety fixes armed (default on)
uint8_t recircHits = 0;
bool    flapBlocked = false;       // recirculation seen but pack low
bool    valveBlocked = false;      // leak seen but pack low
bool    cmdBlocked = false;        // one-shot: manual servo command refused (pack low)
bool    badCmd = false;            // one-shot: unparseable command
uint32_t lastActionMs = 0;
bool    hadAction = false;

int fanPct[2] = { 0, 0 };

uint16_t reservoirRaw = 0;
uint16_t floorRaw = 0;
uint16_t resHist[RES_HIST_LEN];
uint8_t  resHead = 0;
uint8_t  resCount = 0;
bool     reservoirDropping = false;
bool     floorWet = false;

float   packV = NAN;
bool    packFitted = false;        // latched once a healthy pack has been seen on A2
float   packPrevV = 0.0f;
uint8_t packStable = 0;

bool     refPresent = false;
float    refC = NAN;
bool     refConverting = false;
uint32_t refRequestedAt = 0;
uint32_t refNextReqAt = 0;
uint32_t refNextScanAt = 0;
uint8_t  refFailCount = 0;

const char* evQueue[4];
uint8_t evCount = 0;

const uint8_t MAX_FLAGS = 20;
const uint8_t FLAG_LEN = 28;
char    flagBuf[MAX_FLAGS][FLAG_LEN];
uint8_t flagCount = 0;
bool    statusAlert = false;

uint32_t seq = 0;
uint32_t nextFrameAt = 0;
uint32_t nextSampleAt = 0;
uint32_t nextOledAt = 0;
bool     heavySlot = false;

char    lineBuf[48];
uint8_t lineLen = 0;
bool    lineOverflow = false;

#if HAS_DS18B20
OneWire oneWire(P_ONEWIRE);
DallasTemperature dallas(&oneWire);
DeviceAddress refAddr;
#endif

#if HAS_OLED
Adafruit_SSD1306 display(128, 64, &Wire, -1);
#endif
bool    oledOk = false;
uint8_t oledFlagIdx = 0;

#if LED_MATRIX_ENABLED
ArduinoLEDMatrix matrix;
// 8 rows x 12 columns, '#' = lit
const char* const LED_OK_ROWS[8] = {
  "............",
  "..........#.",
  ".........##.",
  "........##..",
  ".#.....##...",
  ".##...##....",
  "..##.##.....",
  "...###......"
};
const char* const LED_ALERT_ROWS[8] = {
  ".....##.....",
  ".....##.....",
  ".....##.....",
  ".....##.....",
  ".....##.....",
  "............",
  ".....##.....",
  ".....##....."
};
uint32_t ledOkFrame[3];
uint32_t ledAlertFrame[3];
int8_t   ledShown = -1;   // -1 none, 0 ok, 1 alert
#endif

// ============================================================================
//  Small helpers
// ============================================================================

bool due(uint32_t now, uint32_t at) {
  return (int32_t)(now - at) >= 0;
}

float soundSpeed(float tC) {
  return 331.3f * sqrtf(1.0f + tC / 273.15f);
}

// Temperature implied by a round-trip echo of echoUs over a one-way path pathM.
float tempFromEcho(float echoUs, float pathM) {
  if (echoUs <= 0.0f) return NAN;
  float c = 2.0f * pathM / (echoUs * 1e-6f);
  float r = c / 331.3f;
  return 273.15f * (r * r - 1.0f);
}

void sortU16(uint16_t* a, uint8_t n) {
  for (uint8_t i = 1; i < n; i++) {
    uint16_t k = a[i];
    int8_t j = (int8_t)i - 1;
    while (j >= 0 && a[j] > k) {
      a[j + 1] = a[j];
      j--;
    }
    a[j + 1] = k;
  }
}

uint16_t readAvg(uint8_t pin, uint8_t n) {
  uint32_t s = 0;
  for (uint8_t i = 0; i < n; i++) s += (uint32_t)analogRead(pin);
  return (uint16_t)((s + n / 2) / n);
}

// Fixed-point "%.1f" without printf float support. NAN -> "--.-".
void fmt1(char* out, size_t n, float x, bool withSign) {
  if (isnan(x)) {
    snprintf(out, n, "--.-");
    return;
  }
  long v = (long)(x * 10.0f + (x >= 0.0f ? 0.5f : -0.5f));
  bool neg = v < 0;
  if (neg) v = -v;
  snprintf(out, n, "%s%ld.%ld", neg ? "-" : (withSign ? "+" : ""), v / 10, v % 10);
}

void pushEvent(const char* e) {
  if (evCount < 4) evQueue[evCount++] = e;
}

const char* popEvent() {
  if (evCount == 0) return NULL;
  const char* e = evQueue[0];
  for (uint8_t i = 1; i < evCount; i++) evQueue[i - 1] = evQueue[i];
  evCount--;
  return e;
}

bool packLow() {
#if HAS_PACK_DIVIDER
  return packFitted && !isnan(packV) && packV < PACK_LOW_V;
#else
  return false;
#endif
}

bool pingsPaused(uint32_t now) {
  return (int32_t)(pingPauseUntil - now) > 0;
}

void pausePingsUntil(uint32_t t) {
  if ((int32_t)(t - pingPauseUntil) > 0) pingPauseUntil = t;
}

// ============================================================================
//  Actuators
// ============================================================================

void actuatorInit(Actuator& a, uint8_t pin, int openDeg, int closedDeg) {
  a.pin = pin;
  a.openDeg = openDeg;
  a.closedDeg = closedDeg;
  a.isOpen = false;
  a.attached = false;
  a.settling = false;
  a.settleUntil = 0;
}

// Drives the servo unconditionally. Callers decide whether a move is allowed.
void moveActuator(Actuator& a, bool open) {
  if (!a.attached) {
    a.servo.attach(a.pin);
    a.attached = true;
  }
  a.servo.write(open ? a.openDeg : a.closedDeg);
  a.isOpen = open;
  a.settling = true;
  a.settleUntil = millis() + SERVO_SETTLE_MS;
  pausePingsUntil(a.settleUntil);   // keep servo noise out of the echo batches
}

void serviceActuator(Actuator& a, uint32_t now) {
  if (a.settling && due(now, a.settleUntil)) {
    a.settling = false;
#if SERVO_DETACH_AFTER_MOVE
    a.servo.detach();
    a.attached = false;
#endif
  }
}

// Manual command path. With the pack known to be low the servo cannot move,
// so the command is refused and the reported state stays truthful.
void commandActuator(Actuator& a, bool open) {
  if (packLow()) {
    cmdBlocked = true;
    return;
  }
  moveActuator(a, open);
}

void setFans(int a, int b) {
  if (a < 0) a = 0;
  if (a > FAN_MAX_PCT) a = FAN_MAX_PCT;
  if (b < 0) b = 0;
  if (b > FAN_MAX_PCT) b = FAN_MAX_PCT;
  fanPct[0] = a;
  fanPct[1] = b;
#if HAS_FANS
  analogWrite(P_FAN_A, (a * 255 + 50) / 100);
  analogWrite(P_FAN_B, (b * 255 + 50) / 100);
#endif
}

// ============================================================================
//  Safety fix 1: recirculation -> close the flap
// ============================================================================

// Called after every inlet_top / inlet_bottom batch (good or not).
void evalRecirc() {
  float top = beams[BEAM_TOP].tempC;
  float bot = beams[BEAM_BOTTOM].tempC;
  bool cond = autoMode && flap.isOpen && !isnan(top) && !isnan(bot) &&
              (top - bot) >= RECIRC_DELTA_C;
  if (!cond) {
    recircHits = 0;
    flapBlocked = false;
    return;
  }
  if (recircHits < 255) recircHits++;
  if (recircHits < RECIRC_CONFIRM) return;
  if (packLow()) {          // servo has no power: report, don't claim
    flapBlocked = true;
    return;
  }
  moveActuator(flap, false);
  pushEvent("flap_closed");
  recircHits = 0;
  flapBlocked = false;
  lastActionMs = millis();
  hadAction = true;
}

// ============================================================================
//  Safety fix 2: coolant leak -> close the valve
// ============================================================================

void resPush(uint16_t v) {
  resHist[resHead] = v;
  resHead = (uint8_t)((resHead + 1) % RES_HIST_LEN);
  if (resCount < RES_HIST_LEN) resCount++;
}

// k = 0 is the newest sample, k = RES_HIST_LEN - 1 the oldest.
uint16_t resAgo(uint8_t k) {
  return resHist[(resHead + RES_HIST_LEN - 1 - k) % RES_HIST_LEN];
}

// Mean of the 3 oldest minus mean of the 3 newest samples in the ~10 s window.
int resDrop() {
  if (resCount < RES_HIST_LEN) return 0;
  int32_t oldest = (int32_t)resAgo(RES_HIST_LEN - 1) + resAgo(RES_HIST_LEN - 2) + resAgo(RES_HIST_LEN - 3);
  int32_t newest = (int32_t)resAgo(0) + resAgo(1) + resAgo(2);
  return (int)((oldest - newest) / 3);
}

void evalLeak() {
  reservoirDropping = resDrop() >= RES_DROP_MIN;
  floorWet = floorRaw >= FLOOR_WET_RAW;
  bool cond = autoMode && valve.isOpen && reservoirDropping && floorWet;
  if (!cond) {
    valveBlocked = false;
    return;
  }
  if (packLow()) {
    valveBlocked = true;
    return;
  }
  moveActuator(valve, false);
  pushEvent("valve_closed");
  valveBlocked = false;
  lastActionMs = millis();
  hadAction = true;
}

// Water + pack, once a second. Cheap (12 ADC reads).
void sampleSlowSensors() {
  reservoirRaw = readAvg(P_RESERVOIR, 4);
  floorRaw = readAvg(P_FLOOR, 4);
  resPush(reservoirRaw);

#if HAS_PACK_DIVIDER
  float v = (float)readAvg(P_PACK, 4) * (PACK_ADC_VREF / 1023.0f) * PACK_DIVIDER;
  packV = v;
  if (!packFitted) {
    // An unconnected A2 floats, and a switched-off pack reads ~0 V through the
    // divider. Only latch "fitted" after a healthy, steady pack reading; from
    // then on report the real value (so a power loss shows as a drop, not null).
    if (v >= PACK_DETECT_MIN_V && v <= PACK_DETECT_MAX_V && fabsf(v - packPrevV) < 0.3f) {
      if (++packStable >= PACK_DETECT_SAMPLES) packFitted = true;
    } else {
      packStable = 0;
    }
    packPrevV = v;
  }
#endif

  evalLeak();
}

// ============================================================================
//  DS18B20 reference probe (asynchronous: never waits for a conversion)
// ============================================================================

void refScan() {
#if HAS_DS18B20
  dallas.begin();
  if (dallas.getDeviceCount() > 0 && dallas.getAddress(refAddr, 0)) {
    dallas.setResolution(refAddr, 12);
    dallas.setWaitForConversion(false);
    refPresent = true;
    refFailCount = 0;
    refConverting = false;
    refNextReqAt = millis();
  } else {
    refPresent = false;
    refC = NAN;
  }
#endif
}

// Returns true if it touched the bus (used one heavy slot).
bool refService(uint32_t now) {
#if HAS_DS18B20
  if (!refPresent) {
    if (due(now, refNextScanAt)) {
      refNextScanAt = now + REF_RESCAN_MS;
      refScan();
      return true;
    }
    return false;
  }
  if (!refConverting) {
    if (due(now, refNextReqAt)) {
      dallas.requestTemperaturesByAddress(refAddr);
      refRequestedAt = now;
      refConverting = true;
      return true;
    }
    return false;
  }
  if (now - refRequestedAt >= REF_CONVERSION_MS) {
    refConverting = false;
    refNextReqAt = refRequestedAt + REF_PERIOD_MS;
    float t = dallas.getTempC(refAddr);
    if (t < -55.0f || t > 125.0f) {   // includes DEVICE_DISCONNECTED_C (-127)
      if (++refFailCount >= 3) {
        refPresent = false;
        refC = NAN;
        refNextScanAt = now + REF_RESCAN_MS;
      }
    } else if (t == 85.0f && (isnan(refC) || fabsf(refC - 85.0f) > 5.0f)) {
      // 85.0 is the DS18B20 power-on value, not a reading
    } else {
      refC = t;
      refFailCount = 0;
    }
    return true;
  }
  return false;
#else
  (void)now;
  return false;
#endif
}

// ============================================================================
//  Acoustic beams
// ============================================================================

uint16_t pingOnce(uint8_t b) {
  digitalWrite(P_TRIG[b], LOW);
  delayMicroseconds(2);
  digitalWrite(P_TRIG[b], HIGH);
  delayMicroseconds(10);
  digitalWrite(P_TRIG[b], LOW);
  unsigned long us = pulseIn(P_ECHO[b], HIGH, ECHO_TIMEOUT_US);   // 0 on timeout
  if (us > 65535UL) us = 0;
  return (uint16_t)us;
}

// Re-derive the path length from this batch: d = c(T_ref) * t / 2.
void tryCalibrate(uint8_t b, const uint16_t* v, uint8_t n, float medianUs) {
  Beam& bm = beams[b];
  if (!refPresent) {
    // No probe on the bus: fall back to the CAD path and say so.
    bm.pathM = DEFAULT_PATH_M;
    bm.calibrated = false;
    bm.calPending = false;
    bm.runningC = NAN;
    return;
  }
  if (isnan(refC)) return;   // probe found, first reading not in yet: try next cycle

  float sum = 0.0f;
  uint8_t k = 0;
  for (uint8_t i = 0; i < n; i++) {
    if (fabsf((float)v[i] - medianUs) <= CAL_WINDOW_US) {
      sum += v[i];
      k++;
    }
  }
  if (k < MIN_GOOD_PINGS) return;   // too scattered: try next cycle

  float t = sum / k;
  float d = soundSpeed(refC) * t * 1e-6f / 2.0f;
  bm.calPending = false;
  bm.runningC = NAN;   // the scale changed; re-seed the outlier reference
  if (d < CAL_PATH_MIN_M || d > CAL_PATH_MAX_M) {
    bm.pathM = DEFAULT_PATH_M;   // implausible (beam not on its reflector?)
    bm.calibrated = false;
    return;
  }
  bm.pathM = d;
  bm.calibrated = true;
}

void processBatch(uint8_t b) {
  Beam& bm = beams[b];
  const uint8_t n = sampleCount;
  float t20Us = 2.0f * bm.pathM / soundSpeed(20.0f) * 1e6f;
  float obstructUs = OBSTRUCT_FRACTION * t20Us;

  uint16_t valid[PINGS_PER_BEAM];
  uint8_t nValid = 0, nTimeout = 0, nObstruct = 0;
  float obstructSum = 0.0f;
  for (uint8_t i = 0; i < n; i++) {
    uint16_t s = samples[i];
    if (s == 0) {
      nTimeout++;
    } else if ((float)s < obstructUs) {
      nObstruct++;
      obstructSum += s;
    } else {
      valid[nValid++] = s;
    }
  }

  bm.lastRejected = 0;

  // Mostly short echoes: something is in the beam. Report the echo, not a temperature.
  if ((uint16_t)nObstruct * 2 >= n) {
    bm.status = BS_OBSTRUCTED;
    bm.echoUs = obstructSum / nObstruct;
    bm.tempC = NAN;
    return;
  }
  // Mostly no echo at all: sensor fault / unplugged / misaimed.
  if ((uint16_t)nTimeout * 2 >= n) {
    bm.status = BS_TIMEOUT;
    bm.echoUs = NAN;
    bm.tempC = NAN;
    return;
  }
  if (nValid < MIN_GOOD_PINGS) {
    bm.status = BS_NOISY;
    bm.echoUs = NAN;
    bm.tempC = NAN;
    return;
  }

  sortU16(valid, nValid);
  float medianUs = (nValid & 1) ? (float)valid[nValid / 2]
                                : 0.5f * ((float)valid[nValid / 2 - 1] + (float)valid[nValid / 2]);

  if (bm.calPending) tryCalibrate(b, valid, nValid, medianUs);

  // Outlier reference: the running value, unless the bulk of this batch (its
  // median) has moved more than MAX_JUMP_C -- then it's a real change, not a
  // single bad echo, so re-seed from the median.
  float medT = tempFromEcho(medianUs, bm.pathM);
  float refT = (!isnan(bm.runningC) && fabsf(medT - bm.runningC) <= MAX_JUMP_C) ? bm.runningC : medT;

  float sum = 0.0f;
  uint8_t nAcc = 0;
  uint8_t rejected = nObstruct;   // stray short echoes count as outliers too
  for (uint8_t i = 0; i < nValid; i++) {
    float t = tempFromEcho((float)valid[i], bm.pathM);
    if (t < T_MIN_C || t > T_MAX_C || fabsf(t - refT) > MAX_JUMP_C) {
      rejected++;
    } else {
      sum += valid[i];
      nAcc++;
    }
  }
  bm.lastRejected = rejected;
  bm.outliersTotal += rejected;

  if (nAcc < MIN_GOOD_PINGS) {
    // Echoes exist but don't imply a plausible temperature (e.g. bench test
    // against a wall that isn't 178 mm away). Keep the median echo visible.
    bm.status = BS_NOISY;
    bm.echoUs = medianUs;
    bm.tempC = NAN;
    return;
  }

  bm.echoUs = sum / nAcc;
  bm.tempC = tempFromEcho(bm.echoUs, bm.pathM);
  bm.runningC = bm.tempC;
  bm.status = BS_OK;
  bm.lastFreshMs = millis();
}

// One ping per call when due. Returns true if it pinged.
bool servicePing(uint32_t now) {
  if (pingsPaused(now)) return false;
  if (now - lastPingMs < PING_GAP_MS) return false;
  samples[sampleCount++] = pingOnce(curBeam);
  if (sampleCount >= PINGS_PER_BEAM) {
    processBatch(curBeam);
    if (curBeam == BEAM_TOP || curBeam == BEAM_BOTTOM) evalRecirc();
    sampleCount = 0;
    curBeam = (uint8_t)((curBeam + 1) % NUM_BEAMS);
  }
  lastPingMs = millis();   // gap is measured from the end of the ping
  return true;
}

// ============================================================================
//  Flags + frame
// ============================================================================

void addFlag(const char* a, const char* b) {
  if (flagCount >= MAX_FLAGS) return;
  snprintf(flagBuf[flagCount++], FLAG_LEN, "%s%s", a, b);
}

void buildFlags(uint32_t now) {
  flagCount = 0;
  bool beamBad = false;
  bool anyUncal = false, anyPending = false;

  for (uint8_t b = 0; b < NUM_BEAMS; b++) {
    const Beam& bm = beams[b];
    switch (bm.status) {
      case BS_TIMEOUT:    addFlag(BEAM_NAME[b], "_timeout");    beamBad = true; break;
      case BS_OBSTRUCTED: addFlag(BEAM_NAME[b], "_obstructed"); beamBad = true; break;
      case BS_NOISY:      addFlag(BEAM_NAME[b], "_noisy");      beamBad = true; break;
      default: break;
    }
    if (bm.lastRejected >= OUTLIER_FLAG_MIN) addFlag(BEAM_NAME[b], "_outliers");
    if (bm.calPending) anyPending = true;
    else if (!bm.calibrated) anyUncal = true;
  }

  bool refDisagree = false;
  if (!refPresent) {
    addFlag("ref_missing", "");
  } else {
    float bot = beams[BEAM_BOTTOM].tempC;
    if (!isnan(refC) && !isnan(bot) && fabsf(bot - refC) > REF_DISAGREE_C) {
      addFlag("ref_disagree", "");
      refDisagree = true;
    }
  }
  if (anyPending) addFlag("calibrating", "");
  if (anyUncal) addFlag("uncalibrated", "");
  bool low = packLow();
  if (low) addFlag("pack_low", "");
  if (flapBlocked) addFlag("flap_blocked", "");
  if (valveBlocked) addFlag("valve_blocked", "");
  if (cmdBlocked) addFlag("cmd_blocked", "");
  if (badCmd) addFlag("bad_cmd", "");
#if HAS_OLED
  if (!oledOk) addFlag("oled_missing", "");
#endif

  bool recentAction = hadAction && (now - lastActionMs) < ACTION_ALERT_MS;
  statusAlert = low || floorWet || beamBad || refDisagree || flapBlocked ||
                valveBlocked || recentAction;
}

void jNum(float x) {
  if (isnan(x)) Serial.print("null");
  else Serial.print(x, 2);
}

void jBeamKey(uint8_t b) {
  if (b) Serial.print(',');
  Serial.print('"');
  Serial.print(BEAM_NAME[b]);
  Serial.print("\":");
}

void updateLedMatrix() {
#if LED_MATRIX_ENABLED
  int8_t want = statusAlert ? 1 : 0;
  if (want != ledShown) {
    matrix.loadFrame(want ? ledAlertFrame : ledOkFrame);
    ledShown = want;
  }
#endif
}

void emitFrame() {
  uint32_t now = millis();
  buildFlags(now);

  Serial.print("{\"v\":1,\"dev\":\"" RM_DEVICE_ID "\",\"fw\":\"" RM_FW_VERSION "\",\"seq\":");
  Serial.print((unsigned long)seq);
  Serial.print(",\"up_ms\":");
  Serial.print((unsigned long)now);

  Serial.print(",\"inlet_top_c\":");
  jNum(beams[BEAM_TOP].tempC);
  Serial.print(",\"inlet_bottom_c\":");
  jNum(beams[BEAM_BOTTOM].tempC);
  Serial.print(",\"outlet_c\":");
  jNum(beams[BEAM_OUTLET].tempC);

  Serial.print(",\"echo_us\":{");
  for (uint8_t b = 0; b < NUM_BEAMS; b++) {
    jBeamKey(b);
    jNum(beams[b].echoUs);
  }
  Serial.print("},\"beam_age_s\":{");
  for (uint8_t b = 0; b < NUM_BEAMS; b++) {
    jBeamKey(b);
    Serial.print((float)(now - beams[b].lastFreshMs) / 1000.0f, 2);
  }
  Serial.print("},\"ref_c\":");
  jNum(refPresent ? refC : NAN);

  Serial.print(",\"reservoir_raw\":");
  Serial.print((int)reservoirRaw);
  Serial.print(",\"floor_raw\":");
  Serial.print((int)floorRaw);

  Serial.print(",\"pack_v\":");
#if HAS_PACK_DIVIDER
  jNum(packFitted ? packV : NAN);
#else
  Serial.print("null");
#endif

  Serial.print(",\"flap\":\"");
  Serial.print(flap.isOpen ? "open" : "closed");
  Serial.print("\",\"valve\":\"");
  Serial.print(valve.isOpen ? "open" : "closed");
  Serial.print("\",\"fan_pct\":[");
  Serial.print(fanPct[0]);
  Serial.print(',');
  Serial.print(fanPct[1]);
  Serial.print("],\"auto\":");
  Serial.print(autoMode ? "true" : "false");

  Serial.print(",\"flags\":[");
  for (uint8_t i = 0; i < flagCount; i++) {
    if (i) Serial.print(',');
    Serial.print('"');
    Serial.print(flagBuf[i]);
    Serial.print('"');
  }
  Serial.print("],\"event\":");
  const char* ev = popEvent();
  if (ev) {
    Serial.print('"');
    Serial.print(ev);
    Serial.print('"');
  } else {
    Serial.print("null");
  }
  Serial.print("}\n");

  seq = (seq + 1) & 0x7FFFFFFFUL;
  cmdBlocked = false;   // one-shot flags are reported once
  badCmd = false;

  updateLedMatrix();
}

// ============================================================================
//  OLED (one full redraw ~25 ms at 400 kHz, at most once per second)
// ============================================================================

void drawOled() {
#if HAS_OLED
  if (!oledOk) return;
  char line[26];
  char a[8], b[8], c[8], d[8];

  float top = beams[BEAM_TOP].tempC;
  float bot = beams[BEAM_BOTTOM].tempC;
  float out = beams[BEAM_OUTLET].tempC;
  float inlet = NAN;
  if (!isnan(top) && !isnan(bot)) inlet = 0.5f * (top + bot);
  else if (!isnan(top)) inlet = top;
  else if (!isnan(bot)) inlet = bot;
  float dT = (!isnan(out) && !isnan(inlet)) ? out - inlet : NAN;

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  // 1: inlet top / inlet bottom > outlet, dT (outlet - mean inlet)
  fmt1(a, sizeof a, top, false);
  fmt1(b, sizeof b, bot, false);
  fmt1(c, sizeof c, out, false);
  fmt1(d, sizeof d, dT, true);
  snprintf(line, sizeof line, "%s/%s>%s d%s", a, b, c, d);
  display.setCursor(0, 0);
  display.print(line);

  // 2: water. 'v' = reservoir dropping
  snprintf(line, sizeof line, "Res%4d%c Flr%4d %s", (int)reservoirRaw,
           reservoirDropping ? 'v' : ' ', (int)floorRaw, floorWet ? "WET" : "dry");
  display.setCursor(0, 16);
  display.print(line);

  // 3: actuators + A(uto)/M(anual)
  snprintf(line, sizeof line, "Flap %s Vlv %s %c", flap.isOpen ? "open" : "shut",
           valve.isOpen ? "open" : "shut", autoMode ? 'A' : 'M');
  display.setCursor(0, 32);
  display.print(line);

  // 4: flags, one at a time, cycling each redraw; or OK + pack voltage
  if (flagCount == 0) {
#if HAS_PACK_DIVIDER
    if (packFitted) {
      fmt1(a, sizeof a, packV, false);
      snprintf(line, sizeof line, "OK  pack %sV", a);
    } else {
      snprintf(line, sizeof line, "OK  pack --");
    }
#else
    snprintf(line, sizeof line, "OK");
#endif
  } else {
    if (oledFlagIdx >= flagCount) oledFlagIdx = 0;
    const char* f = flagBuf[oledFlagIdx];
    if (strncmp(f, "inlet_", 6) == 0) f += 6;   // "inlet_bottom_x" -> "bottom_x"
    snprintf(line, sizeof line, "%u/%u %s", (unsigned)(oledFlagIdx + 1), (unsigned)flagCount, f);
    oledFlagIdx++;
  }
  line[21] = '\0';   // 21 columns at text size 1
  display.setCursor(0, 48);
  display.print(line);

  display.display();
#endif
}

// ============================================================================
//  Commands (newline-terminated, case-insensitive)
// ============================================================================

void handleLine(char* s) {
  char* tok[4];
  uint8_t n = 0;
  char* p = s;
  while (*p && n < 4) {
    while (*p == ' ' || *p == '\t') p++;
    if (!*p) break;
    tok[n++] = p;
    while (*p && *p != ' ' && *p != '\t') p++;
    if (*p) {
      *p = '\0';
      p++;
    }
  }
  if (n == 0) return;

  if (strcmp(tok[0], "flap") == 0 || strcmp(tok[0], "valve") == 0) {
    Actuator& a = (tok[0][0] == 'f') ? flap : valve;
    if (n == 2 && strcmp(tok[1], "open") == 0) {
      commandActuator(a, true);
    } else if (n == 2 && (strcmp(tok[1], "close") == 0 || strcmp(tok[1], "closed") == 0)) {
      commandActuator(a, false);
    } else {
      badCmd = true;
    }
  } else if (strcmp(tok[0], "fan") == 0) {
    if (n != 3) {
      badCmd = true;
      return;
    }
    char* e1;
    char* e2;
    double fa = strtod(tok[1], &e1);
    double fb = strtod(tok[2], &e2);
    if (e1 == tok[1] || *e1 != '\0' || e2 == tok[2] || *e2 != '\0') {
      badCmd = true;
      return;
    }
    if (fa < 0) fa = 0;
    if (fb < 0) fb = 0;
    if (fa > FAN_MAX_PCT) fa = FAN_MAX_PCT;
    if (fb > FAN_MAX_PCT) fb = FAN_MAX_PCT;
    setFans((int)(fa + 0.5), (int)(fb + 0.5));
  } else if (strcmp(tok[0], "auto") == 0) {
    if (n == 2 && strcmp(tok[1], "on") == 0) {
      autoMode = true;
    } else if (n == 2 && strcmp(tok[1], "off") == 0) {
      autoMode = false;
      recircHits = 0;
      flapBlocked = false;
      valveBlocked = false;
    } else {
      badCmd = true;
    }
  } else if (strcmp(tok[0], "cal") == 0 && n == 1) {
    // Re-derive every beam's path on its next good batch (~5 s for all three).
    // Run with the laptop idle so all three beams see room temperature.
    for (uint8_t b = 0; b < NUM_BEAMS; b++) beams[b].calPending = true;
    if (!refPresent) refNextScanAt = millis();   // look for the probe right away
  } else if (strcmp(tok[0], "ping") == 0 && n == 1) {
    emitFrame();
  } else {
    badCmd = true;
  }
}

// Non-blocking: drains what's buffered, never waits for more.
void serviceSerial() {
  uint8_t budget = 64;
  while (budget-- && Serial.available() > 0) {
    int ch = Serial.read();
    if (ch < 0) break;
    if (ch == '\n' || ch == '\r') {
      if (lineOverflow) {
        badCmd = true;
      } else if (lineLen > 0) {
        lineBuf[lineLen] = '\0';
        handleLine(lineBuf);
      }
      lineLen = 0;
      lineOverflow = false;
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = (char)tolower(ch);
    } else {
      lineOverflow = true;
    }
  }
}

// ============================================================================
//  Setup / loop
// ============================================================================

#if HAS_OLED
bool i2cProbe(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}
#endif

#if LED_MATRIX_ENABLED
void packLedRows(const char* const rows[8], uint32_t out[3]) {
  out[0] = out[1] = out[2] = 0;
  for (uint8_t r = 0; r < 8; r++) {
    for (uint8_t c = 0; c < 12; c++) {
      if (rows[r][c] == '#') {
        uint8_t i = r * 12 + c;
        out[i / 32] |= (1UL << (31 - (i % 32)));
      }
    }
  }
}
#endif

void setup() {
  Serial.begin(115200);   // no while(!Serial): must run without a laptop attached
#if defined(ARDUINO_ARCH_RENESAS)
  analogReadResolution(10);   // protocol: water sensors are 10-bit raw 0..1023
#endif

  for (uint8_t b = 0; b < NUM_BEAMS; b++) {
    pinMode(P_TRIG[b], OUTPUT);
    digitalWrite(P_TRIG[b], LOW);
    pinMode(P_ECHO[b], INPUT);
    Beam& bm = beams[b];
    bm.pathM = DEFAULT_PATH_M;
    bm.calibrated = false;
    bm.calPending = true;   // startup calibration on each beam's first good batch
    bm.tempC = NAN;
    bm.echoUs = NAN;
    bm.runningC = NAN;
    bm.lastFreshMs = 0;
    bm.status = BS_NONE;
    bm.lastRejected = 0;
    bm.outliersTotal = 0;
  }

#if HAS_FANS
  pinMode(P_FAN_A, OUTPUT);
  pinMode(P_FAN_B, OUTPUT);
#endif
  setFans(0, 0);

  // Known safe state: flap standing (closed), plug in the leak hole (closed).
  actuatorInit(flap, P_FLAP, FLAP_OPEN_DEG, FLAP_CLOSED_DEG);
  actuatorInit(valve, P_VALVE, VALVE_OPEN_DEG, VALVE_CLOSED_DEG);
  moveActuator(flap, false);
  moveActuator(valve, false);

#if HAS_OLED
  Wire.begin();
  uint8_t addr = 0;
  if (i2cProbe(0x3C)) addr = 0x3C;
  else if (i2cProbe(0x3D)) addr = 0x3D;
  if (addr && display.begin(SSD1306_SWITCHCAPVCC, addr, true, false)) {
    oledOk = true;
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.print("Rack Monitor " RM_FW_VERSION);
    display.setCursor(0, 16);
    display.print("calibrating...");
    display.display();
  }
#endif

#if LED_MATRIX_ENABLED
  matrix.begin();
  packLedRows(LED_OK_ROWS, ledOkFrame);
  packLedRows(LED_ALERT_ROWS, ledAlertFrame);
#endif

  refScan();
  refNextScanAt = millis() + REF_RESCAN_MS;

  uint32_t now = millis();
  nextSampleAt = now;
  nextFrameAt = now + FRAME_PERIOD_MS;
  nextOledAt = now + OLED_PHASE_MS;
  lastPingMs = now;
}

void loop() {
  uint32_t now = millis();

  serviceSerial();
  serviceActuator(flap, now);
  serviceActuator(valve, now);

  if (servicePing(now)) heavySlot = true;   // ~55 ms of quiet until the next ping
  now = millis();
  if (pingsPaused(now)) heavySlot = true;   // servos moving: no pings to protect

  if (due(now, nextSampleAt)) {
    nextSampleAt += SAMPLE_PERIOD_MS;
    if (due(now, nextSampleAt)) nextSampleAt = now + SAMPLE_PERIOD_MS;   // fell behind: resync
    sampleSlowSensors();
  }

  // At most one blocking task (serial frame, OLED, 1-Wire) per gap between pings.
  if (heavySlot) {
    now = millis();
    if (due(now, nextFrameAt)) {
      nextFrameAt += FRAME_PERIOD_MS;
      if (due(now, nextFrameAt)) nextFrameAt = now + FRAME_PERIOD_MS;
      emitFrame();
      heavySlot = false;
    } else if (due(now, nextOledAt)) {
      nextOledAt += OLED_PERIOD_MS;
      if (due(now, nextOledAt)) nextOledAt = now + OLED_PERIOD_MS;
      drawOled();
      heavySlot = false;
    } else if (refService(now)) {
      heavySlot = false;
    }
  }
}
