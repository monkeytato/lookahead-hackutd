// ============================================================================
//  Rack Monitor firmware v2  --  hardware/rack_monitor/rack_monitor.ino
//
//  Board : Arduino UNO R4 WiFi or UNO R4 Minima (Renesas RA4M1 core)
//  Link  : USB serial, 115200 baud, one JSON object (RigFrame v2) per line, ~1 Hz
//  Spec  : src/domain/rig/protocol.ts (authoritative frame/command format)
//
//  STATUS: written without a toolchain -- NOT YET COMPILED OR FLASHED.
//
//  Sensors (four):
//    * DS18B20 temperature probe at the front inlet (D11, 5.1k pull-up).
//      12-bit, one reading every 2 s, read asynchronously (never blocks).
//    * Two HC-SR04 ultrasonic sensors used for VIBRATION, one aimed squarely at
//      each exhaust fan's mount from ~40 mm. They ping alternately every 30 ms
//      (~16 Hz per sensor). Over a window of 64 pings (~3.8 s) the firmware
//      reports the mean distance, the RMS and peak-to-peak wobble around it,
//      an apparent frequency from zero crossings, and an indicative velocity
//      2*pi*f*disp. The ~16 Hz ping rate cannot resolve a 25 Hz shaft rate
//      (Nyquist ~8 Hz), so freq_hz is an aliased, APPARENT frequency and
//      vel_mm_s is a trend number, not an ISO 10816 measurement.
//    * One water level sensor lying flat in the drip tray under the coolant
//      line (A0): raw ADC, ~0 dry, rising as drips cover its traces.
//    Also read: the 6xAA pack through a 10k/10k divider on A2.
//
//  Two on-device safety fixes (when auto is on):
//    * recirculation: inlet >= 1.5 C above its calibrated baseline on two
//      consecutive probe readings with the flap open -> close the flap.
//    * leak: drip tray wet with the isolation valve open -> close the valve.
//    Both are refused (and flagged) when the pack is known to be low, because
//    the servos run off the pack.
// ============================================================================

#include <Arduino.h>
#include <Wire.h>
#include <Servo.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

// ---------------------------------------------------------------- feature flags
#ifndef HAS_DS18B20
#define HAS_DS18B20 1        // DS18B20 on D11. Absent => temp_c null + "temp_missing"
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
#define SERVO_DETACH_AFTER_MOVE 1   // cleaner pings; servos don't hold against force
#endif

#if HAS_DS18B20
#include <OneWire.h>
#include <DallasTemperature.h>
#endif
#if HAS_OLED
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#endif
#if USE_LED_MATRIX && defined(ARDUINO_UNOWIFIR4)
#include <Arduino_LED_Matrix.h>
#define LED_MATRIX_ENABLED 1
#else
#define LED_MATRIX_ENABLED 0
#endif

#define RM_DEVICE_ID  "RACKMON-01"
#define RM_FW_VERSION "2.0.0"

// ---------------------------------------------------------------- pins
const uint8_t NUM_VIB = 2;
const uint8_t P_TRIG[NUM_VIB] = { 2, 7 };     // fan A, fan B
const uint8_t P_ECHO[NUM_VIB] = { 4, 8 };
const char* const VIB_NAME[NUM_VIB] = { "fan_a", "fan_b" };

const uint8_t P_DRIP      = A0;   // water sensor in the drip tray
const uint8_t P_PACK      = A2;   // pack divider midpoint (V_pack = 2 * V_A2)
const uint8_t P_FAN_A     = 5;    // L298N ENA
const uint8_t P_FAN_B     = 6;    // L298N ENB
const uint8_t P_FLAP      = 9;    // flap servo signal
const uint8_t P_VALVE     = 10;   // valve servo signal
const uint8_t P_ONEWIRE   = 11;   // DS18B20 data

// ---------------------------------------------------------------- tunables
const int FLAP_CLOSED_DEG  = 90;
const int FLAP_OPEN_DEG    = 180;   // flap lying back (gap over the divider open)
const int VALVE_CLOSED_DEG = 90;
const int VALVE_OPEN_DEG   = 135;   // plug swung out of the leak hole
const uint32_t SERVO_SETTLE_MS = 700;   // time to finish a move; pings pause meanwhile

// Ultrasonic vibration
const uint8_t  VIB_WINDOW        = 64;      // pings per sensor per window (~3.8 s)
const uint32_t PING_GAP_MS       = 30;      // between any two pings (sensors alternate)
const unsigned long ECHO_TIMEOUT_US = 3000; // ~245 us expected at 42 mm
const float    US_TO_MM          = 0.1715f; // 343 m/s / 2 (room temperature; scale only)
const float    OBSTRUCT_MM       = 15.0f;   // closer than this: something in front of the sensor
const float    MAX_DIST_MM       = 300.0f;  // farther than this: not aimed at the mount
const uint8_t  MIN_GOOD_PINGS    = 24;      // fewer accepted pings => window untrusted ("noisy")
const float    JUMP_MM           = 6.0f;    // single ping this far from the window median = outlier
const float    ZC_MIN_MM         = 0.05f;   // hysteresis for zero-crossing counting
const float    FREQ_MIN_HZ       = 0.3f;

// Probe + recirculation fix
const uint32_t REF_PERIOD_MS     = 2000;
const uint32_t REF_CONVERSION_MS = 800;     // 12-bit conversion is 750 ms (async)
const uint32_t REF_RESCAN_MS     = 10000;
const float    RECIRC_DELTA_C    = 1.5f;    // inlet above baseline by this => recirculation
const uint8_t  RECIRC_CONFIRM    = 2;       // consecutive probe readings that must agree
const float    BASELINE_FLOOR_C  = 10.0f;   // sanity: a baseline below this is not a room

// Leak fix
const uint16_t DRIP_WET_RAW      = 120;     // TUNE: tray sensor above this = wet (dry reads ~0)

// Pack
const float    PACK_ADC_VREF     = 5.0f;    // TUNE: measure the R4's 5V pin on USB
const float    PACK_DIVIDER      = 2.0f;    // 10k / 10k
const float    PACK_LOW_V        = 6.0f;
const float    PACK_DETECT_MIN_V = 6.5f;
const float    PACK_DETECT_MAX_V = 10.5f;
const uint8_t  PACK_DETECT_SAMPLES = 5;
const int      FAN_MAX_PCT       = 70;      // TT motors are 3-6 V on a 9 V pack

// Scheduling
const uint32_t FRAME_PERIOD_MS   = 1000;
const uint32_t SAMPLE_PERIOD_MS  = 1000;
const uint32_t OLED_PERIOD_MS    = 1000;
const uint32_t OLED_PHASE_MS     = 500;
const uint32_t ACTION_ALERT_MS   = 10000;

// ---------------------------------------------------------------- types
enum VibStatus { VS_NONE = 0, VS_OK, VS_TIMEOUT, VS_OBSTRUCTED, VS_NOISY };

struct VibChan {
  uint16_t samples[VIB_WINDOW];   // echo us, 0 = timeout
  uint8_t  count;
  // last computed window
  float    distMm, dispMm, p2pMm, freqHz, velMmS;   // NAN = null
  uint8_t  n;
  uint8_t  status;
  float    baselineMm;            // from "cal"; informational
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
VibChan vib[NUM_VIB];
uint8_t  curVib = 0;
uint32_t lastPingMs = 0;
uint32_t pingPauseUntil = 0;

Actuator flap;
Actuator valve;

bool    autoMode = true;
uint8_t recircHits = 0;
bool    flapBlocked = false;
bool    valveBlocked = false;
bool    cmdBlocked = false;
bool    badCmd = false;
uint32_t lastActionMs = 0;
bool    hadAction = false;

int fanPct[2] = { 0, 0 };

uint16_t dripRaw = 0;
bool     dripWet = false;

float   packV = NAN;
bool    packFitted = false;
float   packPrevV = 0.0f;
uint8_t packStable = 0;

bool     refPresent = false;
float    tempC = NAN;
bool     tempInvalid = false;
float    baselineC = NAN;
bool     calibrated = false;
bool     refConverting = false;
uint32_t refRequestedAt = 0;
uint32_t refNextReqAt = 0;
uint32_t refNextScanAt = 0;
uint8_t  refFailCount = 0;

const char* evQueue[4];
uint8_t evCount = 0;

const uint8_t MAX_FLAGS = 16;
const uint8_t FLAG_LEN = 24;
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
const char* const LED_OK_ROWS[8] = {
  "............", "..........#.", ".........##.", "........##..",
  ".#.....##...", ".##...##....", "..##.##.....", "...###......",
};
const char* const LED_ALERT_ROWS[8] = {
  ".....##.....", ".....##.....", ".....##.....", ".....##.....",
  ".....##.....", "............", ".....##.....", ".....##.....",
};
uint32_t ledOkFrame[3];
uint32_t ledAlertFrame[3];
int8_t   ledShown = -1;
#endif

// ============================================================================
//  Small helpers
// ============================================================================

bool due(uint32_t now, uint32_t at) { return (int32_t)(now - at) >= 0; }

uint16_t readAvg(uint8_t pin, uint8_t n) {
  uint32_t s = 0;
  for (uint8_t i = 0; i < n; i++) s += analogRead(pin);
  return (uint16_t)(s / n);
}

void fmt1(char* out, size_t cap, float x, bool sign) {
  if (isnan(x)) { snprintf(out, cap, "--"); return; }
  if (sign) snprintf(out, cap, "%+.1f", (double)x);
  else snprintf(out, cap, "%.1f", (double)x);
}

void sortF(float* v, uint8_t n) {
  for (uint8_t i = 1; i < n; i++) {
    float x = v[i];
    int8_t j = (int8_t)i - 1;
    while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; }
    v[j + 1] = x;
  }
}

void pushEvent(const char* e) { if (evCount < 4) evQueue[evCount++] = e; }

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

bool pingsPaused(uint32_t now) { return (int32_t)(pingPauseUntil - now) > 0; }
void pausePingsUntil(uint32_t t) { if ((int32_t)(t - pingPauseUntil) > 0) pingPauseUntil = t; }

// ============================================================================
//  Actuators
// ============================================================================

void actuatorInit(Actuator& a, uint8_t pin, int openDeg, int closedDeg) {
  a.pin = pin; a.openDeg = openDeg; a.closedDeg = closedDeg;
  a.isOpen = false; a.attached = false; a.settling = false; a.settleUntil = 0;
}

void moveActuator(Actuator& a, bool open) {
  if (!a.attached) { a.servo.attach(a.pin); a.attached = true; }
  a.servo.write(open ? a.openDeg : a.closedDeg);
  a.isOpen = open;
  a.settling = true;
  a.settleUntil = millis() + SERVO_SETTLE_MS;
  pausePingsUntil(a.settleUntil);   // keep servo noise out of the vibration window
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

void commandActuator(Actuator& a, bool open) {
  if (packLow()) { cmdBlocked = true; return; }
  moveActuator(a, open);
}

void setFans(int a, int b) {
  if (a < 0) a = 0; if (a > FAN_MAX_PCT) a = FAN_MAX_PCT;
  if (b < 0) b = 0; if (b > FAN_MAX_PCT) b = FAN_MAX_PCT;
  fanPct[0] = a; fanPct[1] = b;
#if HAS_FANS
  analogWrite(P_FAN_A, (a * 255 + 50) / 100);
  analogWrite(P_FAN_B, (b * 255 + 50) / 100);
#endif
}

// ============================================================================
//  Safety fix 1: recirculation -> close the flap (on every probe reading)
// ============================================================================

void evalRecirc() {
  bool cond = autoMode && flap.isOpen && calibrated && !tempInvalid && !isnan(tempC) &&
              (tempC - baselineC) >= RECIRC_DELTA_C;
  if (!cond) { recircHits = 0; flapBlocked = false; return; }
  if (recircHits < 255) recircHits++;
  if (recircHits < RECIRC_CONFIRM) return;
  if (packLow()) { flapBlocked = true; return; }
  moveActuator(flap, false);
  pushEvent("flap_closed");
  recircHits = 0;
  flapBlocked = false;
  lastActionMs = millis();
  hadAction = true;
}

// ============================================================================
//  Safety fix 2: coolant drip -> close the valve (once a second)
// ============================================================================

void evalLeak() {
  dripWet = dripRaw >= DRIP_WET_RAW;
  bool cond = autoMode && valve.isOpen && dripWet;
  if (!cond) { valveBlocked = false; return; }
  if (packLow()) { valveBlocked = true; return; }
  moveActuator(valve, false);
  pushEvent("valve_closed");
  valveBlocked = false;
  lastActionMs = millis();
  hadAction = true;
}

void sampleSlowSensors() {
  dripRaw = readAvg(P_DRIP, 4);
#if HAS_PACK_DIVIDER
  float v = (float)readAvg(P_PACK, 4) * (PACK_ADC_VREF / 1023.0f) * PACK_DIVIDER;
  packV = v;
  if (!packFitted) {
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
//  DS18B20 inlet probe (asynchronous)
// ============================================================================

void refScan() {
#if HAS_DS18B20
  dallas.begin();
  if (dallas.getDeviceCount() > 0 && dallas.getAddress(refAddr, 0)) {
    dallas.setResolution(refAddr, 12);
    dallas.setWaitForConversion(false);
    refPresent = true; refFailCount = 0; refConverting = false;
    refNextReqAt = millis();
  } else {
    refPresent = false; tempC = NAN;
  }
#endif
}

void onProbeReading(float t) {
  tempC = t;
  tempInvalid = false;
  if (!calibrated && t > BASELINE_FLOOR_C) { baselineC = t; calibrated = true; }   // first reading = baseline
  evalRecirc();
}

bool refService(uint32_t now) {
#if HAS_DS18B20
  if (!refPresent) {
    if (due(now, refNextScanAt)) { refNextScanAt = now + REF_RESCAN_MS; refScan(); return true; }
    return false;
  }
  if (!refConverting) {
    if (due(now, refNextReqAt)) {
      dallas.requestTemperaturesByAddress(refAddr);
      refRequestedAt = now; refConverting = true;
      return true;
    }
    return false;
  }
  if (now - refRequestedAt >= REF_CONVERSION_MS) {
    refConverting = false;
    refNextReqAt = refRequestedAt + REF_PERIOD_MS;
    float t = dallas.getTempC(refAddr);
    if (t < -55.0f || t > 125.0f) {        // includes DEVICE_DISCONNECTED_C (-127)
      tempInvalid = true;
      if (++refFailCount >= 3) { refPresent = false; tempC = NAN; refNextScanAt = now + REF_RESCAN_MS; }
    } else if (t == 85.0f && (isnan(tempC) || fabsf(tempC - 85.0f) > 5.0f)) {
      // 85.0 is the DS18B20 power-on value, not a reading
    } else {
      refFailCount = 0;
      onProbeReading(t);
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
//  Ultrasonic vibration
// ============================================================================

uint16_t pingOnce(uint8_t c) {
  digitalWrite(P_TRIG[c], LOW);
  delayMicroseconds(2);
  digitalWrite(P_TRIG[c], HIGH);
  delayMicroseconds(10);
  digitalWrite(P_TRIG[c], LOW);
  unsigned long us = pulseIn(P_ECHO[c], HIGH, ECHO_TIMEOUT_US);   // 0 on timeout
  if (us > 65535UL) us = 0;
  return (uint16_t)us;
}

// One window: mean distance, detrended RMS and p2p wobble, zero-crossing frequency.
void processWindow(uint8_t c) {
  VibChan& v = vib[c];
  const uint8_t n = v.count;
  float d[VIB_WINDOW];
  uint8_t nValid = 0, nTimeout = 0, nObstruct = 0;
  float obstructSum = 0.0f;
  for (uint8_t i = 0; i < n; i++) {
    uint16_t s = v.samples[i];
    if (s == 0) { nTimeout++; continue; }
    float mm = (float)s * US_TO_MM;
    if (mm < OBSTRUCT_MM) { nObstruct++; obstructSum += mm; continue; }
    if (mm > MAX_DIST_MM) { nTimeout++; continue; }   // not looking at the mount
    d[nValid++] = mm;
  }
  v.dispMm = v.p2pMm = v.freqHz = v.velMmS = NAN;
  v.n = nValid;
  if ((uint16_t)nObstruct * 2 >= n) { v.status = VS_OBSTRUCTED; v.distMm = obstructSum / nObstruct; return; }
  if ((uint16_t)nTimeout * 2 >= n)  { v.status = VS_TIMEOUT; v.distMm = NAN; return; }
  if (nValid < MIN_GOOD_PINGS)      { v.status = VS_NOISY; v.distMm = NAN; return; }

  // median for outlier rejection, keeping the time order of accepted samples
  float sorted[VIB_WINDOW];
  memcpy(sorted, d, nValid * sizeof(float));
  sortF(sorted, nValid);
  float median = (nValid & 1) ? sorted[nValid / 2] : 0.5f * (sorted[nValid / 2 - 1] + sorted[nValid / 2]);
  float acc[VIB_WINDOW];
  uint8_t m = 0;
  for (uint8_t i = 0; i < nValid; i++) if (fabsf(d[i] - median) <= JUMP_MM) acc[m++] = d[i];
  if (m < MIN_GOOD_PINGS) { v.status = VS_NOISY; v.distMm = median; v.n = m; return; }
  v.n = m;

  // linear detrend (slow drift of the mount or the rig being nudged)
  float sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (uint8_t i = 0; i < m; i++) { sx += i; sy += acc[i]; sxy += (float)i * acc[i]; sxx += (float)i * i; }
  float slope = (m * sxx - sx * sx) != 0 ? (m * sxy - sx * sy) / (m * sxx - sx * sx) : 0;
  float mean = sy / m;
  float intercept = mean - slope * (sx / m);
  float ss = 0, lo = 1e9f, hi = -1e9f;
  uint8_t zc = 0;
  int8_t sign = 0;
  for (uint8_t i = 0; i < m; i++) {
    float r = acc[i] - (intercept + slope * i);
    ss += r * r;
    if (r < lo) lo = r;
    if (r > hi) hi = r;
    int8_t s = r > ZC_MIN_MM ? 1 : r < -ZC_MIN_MM ? -1 : 0;
    if (s != 0) { if (sign != 0 && s != sign) zc++; sign = s; }
  }
  v.distMm = mean;
  v.dispMm = sqrtf(ss / m);
  v.p2pMm = hi - lo;
  float windowS = (float)m * (2.0f * PING_GAP_MS) / 1000.0f;   // this sensor pings every other gap
  float f = windowS > 0 ? (float)zc / (2.0f * windowS) : 0;
  v.freqHz = f >= FREQ_MIN_HZ ? f : NAN;
  v.velMmS = isnan(v.freqHz) ? NAN : 2.0f * (float)M_PI * v.freqHz * v.dispMm;
  v.status = VS_OK;
}

bool servicePing(uint32_t now) {
  if (pingsPaused(now)) return false;
  if (now - lastPingMs < PING_GAP_MS) return false;
  VibChan& v = vib[curVib];
  v.samples[v.count++] = pingOnce(curVib);
  if (v.count >= VIB_WINDOW) { processWindow(curVib); v.count = 0; }
  curVib = (uint8_t)((curVib + 1) % NUM_VIB);
  lastPingMs = millis();
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
  bool vibBad = false;
  for (uint8_t c = 0; c < NUM_VIB; c++) {
    switch (vib[c].status) {
      case VS_TIMEOUT:    addFlag(VIB_NAME[c], "_timeout");    vibBad = true; break;
      case VS_OBSTRUCTED: addFlag(VIB_NAME[c], "_obstructed"); vibBad = true; break;
      case VS_NOISY:      addFlag(VIB_NAME[c], "_noisy");      vibBad = true; break;
      default: break;
    }
  }
  if (!refPresent) addFlag("temp_missing", "");
  else if (tempInvalid) addFlag("temp_invalid", "");
  if (!calibrated) addFlag("uncalibrated", "");
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
  statusAlert = low || dripWet || vibBad || flapBlocked || valveBlocked || recentAction;
}

void jNum(float x, int dp = 2) {
  if (isnan(x)) Serial.print("null");
  else Serial.print(x, dp);
}

void jVib(uint8_t c) {
  const VibChan& v = vib[c];
  if (c) Serial.print(',');
  Serial.print('"'); Serial.print(VIB_NAME[c]); Serial.print("\":{\"dist_mm\":");
  jNum(v.distMm, 1);
  Serial.print(",\"disp_mm\":"); jNum(v.dispMm, 3);
  Serial.print(",\"p2p_mm\":");  jNum(v.p2pMm, 3);
  Serial.print(",\"freq_hz\":"); jNum(v.freqHz, 1);
  Serial.print(",\"vel_mm_s\":"); jNum(v.velMmS, 2);
  Serial.print(",\"n\":"); Serial.print((int)v.n);
  Serial.print('}');
}

void updateLedMatrix() {
#if LED_MATRIX_ENABLED
  int8_t want = statusAlert ? 1 : 0;
  if (want != ledShown) { matrix.loadFrame(want ? ledAlertFrame : ledOkFrame); ledShown = want; }
#endif
}

void emitFrame() {
  uint32_t now = millis();
  buildFlags(now);

  Serial.print("{\"v\":2,\"dev\":\"" RM_DEVICE_ID "\",\"fw\":\"" RM_FW_VERSION "\",\"seq\":");
  Serial.print((unsigned long)seq);
  Serial.print(",\"up_ms\":");
  Serial.print((unsigned long)now);
  Serial.print(",\"temp_c\":");
  jNum(refPresent ? tempC : NAN, 4);
  Serial.print(",\"vib\":{");
  for (uint8_t c = 0; c < NUM_VIB; c++) jVib(c);
  Serial.print("},\"drip_raw\":");
  Serial.print((int)dripRaw);
  Serial.print(",\"pack_v\":");
#if HAS_PACK_DIVIDER
  jNum(packFitted ? packV : NAN);
#else
  Serial.print("null");
#endif
  Serial.print(",\"flap\":\"");  Serial.print(flap.isOpen ? "open" : "closed");
  Serial.print("\",\"valve\":\""); Serial.print(valve.isOpen ? "open" : "closed");
  Serial.print("\",\"fan_pct\":["); Serial.print(fanPct[0]); Serial.print(','); Serial.print(fanPct[1]);
  Serial.print("],\"auto\":"); Serial.print(autoMode ? "true" : "false");
  Serial.print(",\"flags\":[");
  for (uint8_t i = 0; i < flagCount; i++) {
    if (i) Serial.print(',');
    Serial.print('"'); Serial.print(flagBuf[i]); Serial.print('"');
  }
  Serial.print("],\"event\":");
  const char* ev = popEvent();
  if (ev) { Serial.print('"'); Serial.print(ev); Serial.print('"'); } else Serial.print("null");
  Serial.print("}\n");

  seq = (seq + 1) & 0x7FFFFFFFUL;
  cmdBlocked = false;
  badCmd = false;
  updateLedMatrix();
}

// ============================================================================
//  OLED (4 lines)
// ============================================================================

void drawOled() {
#if HAS_OLED
  if (!oledOk) return;
  char line[26];
  char a[8], b[8], c[8];

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  // 1: inlet temperature and its rise over baseline
  fmt1(a, sizeof a, tempC, false);
  fmt1(b, sizeof b, calibrated && !isnan(tempC) ? tempC - baselineC : NAN, true);
  snprintf(line, sizeof line, "In %sC  d%s", a, b);
  display.setCursor(0, 0); display.print(line);

  // 2: fan vibration, indicative mm/s each
  fmt1(a, sizeof a, vib[0].velMmS, false);
  fmt1(b, sizeof b, vib[1].velMmS, false);
  snprintf(line, sizeof line, "Vib A%s B%s mm/s", a, b);
  display.setCursor(0, 16); display.print(line);

  // 3: tray + actuators
  snprintf(line, sizeof line, "Tray%4d %s F%s V%s %c", (int)dripRaw, dripWet ? "WET" : "dry",
           flap.isOpen ? "op" : "sh", valve.isOpen ? "op" : "sh", autoMode ? 'A' : 'M');
  display.setCursor(0, 32); display.print(line);

  // 4: flags cycling, or OK + pack
  if (flagCount == 0) {
#if HAS_PACK_DIVIDER
    if (packFitted) { fmt1(c, sizeof c, packV, false); snprintf(line, sizeof line, "OK  pack %sV", c); }
    else snprintf(line, sizeof line, "OK  pack --");
#else
    snprintf(line, sizeof line, "OK");
#endif
  } else {
    if (oledFlagIdx >= flagCount) oledFlagIdx = 0;
    snprintf(line, sizeof line, "%u/%u %s", (unsigned)(oledFlagIdx + 1), (unsigned)flagCount, flagBuf[oledFlagIdx]);
    oledFlagIdx++;
  }
  line[21] = '\0';
  display.setCursor(0, 48); display.print(line);
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
    if (*p) { *p = '\0'; p++; }
  }
  if (n == 0) return;

  if (strcmp(tok[0], "flap") == 0 || strcmp(tok[0], "valve") == 0) {
    Actuator& a = (tok[0][0] == 'f') ? flap : valve;
    if (n == 2 && strcmp(tok[1], "open") == 0) commandActuator(a, true);
    else if (n == 2 && (strcmp(tok[1], "close") == 0 || strcmp(tok[1], "closed") == 0)) commandActuator(a, false);
    else badCmd = true;
  } else if (strcmp(tok[0], "fan") == 0) {
    if (n != 3) { badCmd = true; return; }
    char* e1; char* e2;
    double fa = strtod(tok[1], &e1);
    double fb = strtod(tok[2], &e2);
    if (e1 == tok[1] || *e1 != '\0' || e2 == tok[2] || *e2 != '\0') { badCmd = true; return; }
    setFans((int)(fa + 0.5), (int)(fb + 0.5));
  } else if (strcmp(tok[0], "auto") == 0) {
    if (n == 2 && strcmp(tok[1], "on") == 0) autoMode = true;
    else if (n == 2 && strcmp(tok[1], "off") == 0) { autoMode = false; recircHits = 0; flapBlocked = false; valveBlocked = false; }
    else badCmd = true;
  } else if (strcmp(tok[0], "cal") == 0 && n == 1) {
    // Baseline = the current inlet reading (do it with the flap shut and the laptop idle),
    // and remember each sensor's mean distance to its fan mount.
    if (!isnan(tempC) && tempC > BASELINE_FLOOR_C) { baselineC = tempC; calibrated = true; }
    else calibrated = false;
    for (uint8_t c = 0; c < NUM_VIB; c++) vib[c].baselineMm = vib[c].distMm;
    if (!refPresent) refNextScanAt = millis();
  } else if (strcmp(tok[0], "ping") == 0 && n == 1) {
    emitFrame();
  } else {
    badCmd = true;
  }
}

void serviceSerial() {
  uint8_t budget = 64;
  while (budget-- && Serial.available() > 0) {
    int ch = Serial.read();
    if (ch < 0) break;
    if (ch == '\n' || ch == '\r') {
      if (lineOverflow) badCmd = true;
      else if (lineLen > 0) { lineBuf[lineLen] = '\0'; handleLine(lineBuf); }
      lineLen = 0; lineOverflow = false;
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
bool i2cProbe(uint8_t addr) { Wire.beginTransmission(addr); return Wire.endTransmission() == 0; }
#endif

#if LED_MATRIX_ENABLED
void packLedRows(const char* const rows[8], uint32_t out[3]) {
  out[0] = out[1] = out[2] = 0;
  for (uint8_t r = 0; r < 8; r++)
    for (uint8_t c = 0; c < 12; c++)
      if (rows[r][c] == '#') { uint8_t i = r * 12 + c; out[i / 32] |= (1UL << (31 - (i % 32))); }
}
#endif

void setup() {
  Serial.begin(115200);   // no while(!Serial): must run without a laptop attached
#if defined(ARDUINO_ARCH_RENESAS)
  analogReadResolution(10);
#endif

  for (uint8_t c = 0; c < NUM_VIB; c++) {
    pinMode(P_TRIG[c], OUTPUT);
    digitalWrite(P_TRIG[c], LOW);
    pinMode(P_ECHO[c], INPUT);
    VibChan& v = vib[c];
    v.count = 0;
    v.distMm = v.dispMm = v.p2pMm = v.freqHz = v.velMmS = v.baselineMm = NAN;
    v.n = 0;
    v.status = VS_NONE;
  }

#if HAS_FANS
  pinMode(P_FAN_A, OUTPUT);
  pinMode(P_FAN_B, OUTPUT);
#endif
  setFans(0, 0);

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
    display.setCursor(0, 0);  display.print("Rack Monitor " RM_FW_VERSION);
    display.setCursor(0, 16); display.print("waiting for probe...");
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

  if (servicePing(now)) heavySlot = true;   // ~25 ms of quiet until the next ping
  now = millis();
  if (pingsPaused(now)) heavySlot = true;

  if (due(now, nextSampleAt)) {
    nextSampleAt += SAMPLE_PERIOD_MS;
    if (due(now, nextSampleAt)) nextSampleAt = now + SAMPLE_PERIOD_MS;
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
