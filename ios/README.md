# LookaHead native iPhone controller

A real SwiftUI app, not a web wrapper. Its Xcode project is `LookaheadRemote.xcodeproj`; regenerate with `xcodegen generate --spec ios/project.yml` from repository root if needed.

## Run on your iPhone

1. On the Mac, start the existing project: `RACKMON_SIM=1 npm run dev:lan` for a simulator-only demonstration. To use compatible physical firmware, deliberately choose `RACKMON_SIM=0` or the default auto mode, and release that port from Arduino Serial Monitor first. Do not terminate an unrelated serial session.
2. Open `ios/LookaheadRemote.xcodeproj` in Xcode. Select scheme LookaheadRemote and the connected iPhone. In Signing & Capabilities choose your existing Personal Team. The app bundle is `com.lookahead.remote`.
3. Press Run. Unlock/trust the Mac and developer certificate if iOS requests it. Follow actual device/Xcode prompts; do not disable system protections.
4. Put the Mac and iPhone on the same trusted Wi-Fi. Open the app's **Connect** sheet and enter the laptop's current private address with port 5173, e.g. `http://192.168.1.20:5173`. The prefilled previous-session address is only a convenience and may need changing. Allow Local Network access for this app when prompted.
5. Test connection. Keep the web Operations view open. Choose a warning and tap **Simulate error**. The shared incident should appear on both devices within roughly two seconds.

Alternatively, use `TEAM_ID=YOUR_TEAM DEVICE_ID=YOUR_DEVICE ./scripts/install-iphone.sh` from repository root. This uses automatic signing with Xcode's existing account; it does not provision a new account for you.

The device-SDK build was validated unsigned. No signed installation or phone launch was possible from the current restricted session: CoreDevice service times out and no signing identities are visible.

## Controller flow

- **Controller:** deliberately simulate a temperature alert, water leak, cooling failure or vibration alert. These inject software warnings only; no actuator or physical equipment commands are sent.
- **Response:** select an incident, read its exact equipment/measurement point, collect a ten-second scan, assign a qualified technician, record actual checklist work and close with an outcome. Labelled fixture references are available inside a disclosure.
- **Sensor:** fresh versus stale current prototype values, source and device ID. One portable module measures one point, not the whole facility.
- **Review handoff gaps:** record a rule-based gap review on the laptop's Handoff screen.

## Contract

`GET /api/workflow` returns version, revision, issues, events, analyses, prototype and analyzing. `POST /api/workflow` takes a `type`, relevant issue fields and actor. The server validates actions and returns the new snapshot. Commands include simulate_error, acknowledge, verify_fixture, verify_scan, assign, check, resolve, evaluate, note, review and reset.

Real sensor scans use `POST /api/scans/start` and the bridge's ten-second auto-completion. Then `verify_scan` attaches a stored server-owned scan ID. The app cannot submit arbitrary measurement values as evidence. This path differs from the older stage endpoint, which expects `{ "cmd": ... }`; do not confuse the two.

The Swift app uses private LAN HTTP during development. Its transport permits local networking and its URL validator rejects public hosts. The existing bridge has no production authentication; do not publish it or forward its port to the internet.

## Physical prototype compatibility

The existing bridge expects v1 JSON lines at 115200 baud. Temperature comes from `ref_c` when fitted, otherwise the available acoustic inlet estimate; null means unavailable. Water uses raw `floor_raw`; the current scan default treats raw values >=120 as wet. Calibrate that threshold for your actual probe before claiming reliable detection.

The new optional field `vibrating: true|false|null` is backward compatible. A scan reports the fraction of frames with vibration detected. This is qualitative and must not be presented as measured mm/s. If that field is absent, the app says Channel unavailable. No vibration hardware capability is fabricated from ultrasonic data. Existing firmware and wiring were not changed or flashed.

Your current Arduino sketch must actually emit the expected fields. Human-readable Serial output needs a reviewed adapter before this app can consume it. Preserve the sketch and wiring until that is verified.
