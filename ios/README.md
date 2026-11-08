# iPhone apps

This folder holds two separate SwiftUI apps:

- **LookaheadRemote** (`ios/LookaheadRemote/`, spec `project.yml`, committed `LookaheadRemote.xcodeproj`): the incident-workflow controller that talks to `/api/workflow`.
- **Lookahead** (`ios/Lookahead/`, spec `Lookahead.yml`): the read-mostly dial companion that talks to `/api/phone`.

## LookaHead native iPhone controller

A real SwiftUI app, not a web wrapper. Its Xcode project is `LookaheadRemote.xcodeproj`; regenerate with `xcodegen generate --spec ios/project.yml` from repository root if needed.

### Run on your iPhone

1. On the Mac, start the existing project: `RACKMON_SIM=1 npm run dev:lan` for a simulator-only demonstration. To use compatible physical firmware, deliberately choose `RACKMON_SIM=0` or the default auto mode, and release that port from Arduino Serial Monitor first. Do not terminate an unrelated serial session.
2. Open `ios/LookaheadRemote.xcodeproj` in Xcode. Select scheme LookaheadRemote and the connected iPhone. In Signing & Capabilities choose your existing Personal Team. The app bundle is `com.lookahead.remote`.
3. Press Run. Unlock/trust the Mac and developer certificate if iOS requests it. Follow actual device/Xcode prompts; do not disable system protections.
4. Put the Mac and iPhone on the same trusted Wi-Fi. Open the app's **Connect** sheet and enter the laptop's current private address with port 5173, e.g. `http://192.168.1.20:5173`. The prefilled previous-session address is only a convenience and may need changing. Allow Local Network access for this app when prompted.
5. Test connection. Keep the web Operations view open. Choose a warning and tap **Simulate error**. The shared incident should appear on both devices within roughly two seconds.

Alternatively, use `TEAM_ID=YOUR_TEAM DEVICE_ID=YOUR_DEVICE ./scripts/install-iphone.sh` from repository root. This uses automatic signing with Xcode's existing account; it does not provision a new account for you.

The device-SDK build was validated unsigned. No signed installation or phone launch was possible from the current restricted session: CoreDevice service times out and no signing identities are visible.

### Controller flow

- **Controller:** deliberately simulate a temperature alert, water leak, cooling failure or vibration alert. These inject software warnings only; no actuator or physical equipment commands are sent.
- **Response:** select an incident, read its exact equipment/measurement point, collect a ten-second scan, assign a qualified technician, record actual checklist work and close with an outcome. Labelled fixture references are available inside a disclosure.
- **Sensor:** fresh versus stale current prototype values, source and device ID. One portable module measures one point, not the whole facility.
- **Review handoff gaps:** record a rule-based gap review on the laptop's Handoff screen.

### Contract

`GET /api/workflow` returns version, revision, issues, events, analyses, prototype and analyzing. `POST /api/workflow` takes a `type`, relevant issue fields and actor. The server validates actions and returns the new snapshot. Commands include simulate_error, acknowledge, verify_fixture, verify_scan, assign, check, resolve, evaluate, note, review and reset.

Real sensor scans use `POST /api/scans/start` and the bridge's ten-second auto-completion. Then `verify_scan` attaches a stored server-owned scan ID. The app cannot submit arbitrary measurement values as evidence. This path differs from the older stage endpoint, which expects `{ "cmd": ... }`; do not confuse the two.

The Swift app uses private LAN HTTP during development. Its transport permits local networking and its URL validator rejects public hosts. The existing bridge has no production authentication; do not publish it or forward its port to the internet.

### Physical prototype compatibility

The existing bridge expects v1 JSON lines at 115200 baud. Temperature comes from `ref_c` when fitted, otherwise the available acoustic inlet estimate; null means unavailable. Water uses raw `floor_raw`; the current scan default treats raw values >=120 as wet. Calibrate that threshold for your actual probe before claiming reliable detection.

The new optional field `vibrating: true|false|null` is backward compatible. A scan reports the fraction of frames with vibration detected. This is qualitative and must not be presented as measured mm/s. If that field is absent, the app says Channel unavailable. No vibration hardware capability is fabricated from ultrasonic data. Existing firmware and wiring were not changed or flashed.

Your current Arduino sketch must actually emit the expected fields. Human-readable Serial output needs a reviewed adapter before this app can consume it. Preserve the sketch and wiring until that is verified.

## Lookahead (dial companion)

A small SwiftUI companion to the laptop dashboard. It shows the essentials and leaves the detail on the laptop:
- minutes to the first rack loss, as one large dial;
- racks at risk and the live rack-inlet temperature, as two small dials;
- what needs attention, each with a **Fix** button that shows the engine's predicted savings;
- a floating control bar: back 5 · play/pause · forward 5 · random disaster · prediction.

The phone computes nothing. Every number comes from `GET /api/phone` on the laptop (see `server/phoneSummary.ts`). Gray means normal; amber and red appear only when something is wrong, the same rule as the web app.

### Run it on your iPhone (needs a Mac with Xcode 15 or later)

1. Install XcodeGen once: `brew install xcodegen`
2. Generate the project, then open it:
   ```bash
   cd ios
   xcodegen --spec Lookahead.yml
   open Lookahead.xcodeproj
   ```
3. In Xcode, select the **Lookahead** target → **Signing & Capabilities** and pick your **Team**. A free personal Apple ID works.
   - If Xcode says the bundle id is taken, change `com.hackutd2026.lookahead` to something unique.
4. Plug in the iPhone (or pick it over Wi-Fi), choose it as the run destination, and press **Run** (⌘R).
   - On the phone, the first launch from a free account needs **Settings → General → VPN & Device Management → trust your developer certificate**.
   - On iOS 16+, also turn on **Settings → Privacy & Security → Developer Mode** when prompted.
5. Tests: ⌘U runs `LookaheadTests`. They decode the sample the server's own tests generate, so they prove the app and the laptop agree on the data.

### Connect to the laptop

1. On the laptop: `npm run dev:lan` (from `lookahead/`). Vite prints a **Network** address like `http://192.168.1.20:5173`.
2. Open the app, tap the settings icon (top right), enter `192.168.1.20:5173`, and tap **Connect**.
3. When iOS asks to find devices on your local network, allow it. The status dot (top left) turns green: **Live**.

Both devices must be on the same Wi-Fi. Many campus and hackathon networks block device-to-device traffic. If the app can't connect, use a phone hotspot with the laptop joined to it.

No laptop handy? **Settings → Use sample data** shows a saved snapshot, with controls turned off.

### Files

```
project.yml               XcodeGen spec (iOS 17+, iPhone, portrait; local-network HTTP allowed for the dev build)
Lookahead/App             app entry
Lookahead/Core            models (the /api/phone contract), HTTP client, formatting, the polling store
Lookahead/UI              dials, header, problems and fix sheet, control bar, settings
Lookahead/Resources       app icon, accent color, phone-sample.json (copied from tests/server/__fixtures__)
LookaheadTests            decoding, formatting and command tests
```

When the server contract changes, regenerate `tests/server/__fixtures__/phone-sample.json` with `npx vitest run tests/server` and copy it to `Lookahead/Resources/`.
