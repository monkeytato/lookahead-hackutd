import SwiftUI

struct RemoteRoot: View {
    @EnvironmentObject var c: RemoteConnection
    @State private var settings = false
    var body: some View {
        TabView {
            NavigationStack { DemoView().toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Connect", systemImage: "network") { settings = true } } } }
                .tabItem { Label("Controller", systemImage: "switch.2") }
            NavigationStack { ResponseList() }.tabItem { Label("Response", systemImage: "checklist") }
            NavigationStack { SensorView() }.tabItem { Label("Sensor", systemImage: "sensor") }
        }
        .sheet(isPresented: $settings) { ConnectionView() }
        .task { while !Task.isCancelled { await c.refresh(); try? await Task.sleep(for: .seconds(2)) } }
        .alert("CenterGuard", isPresented: Binding(get: { c.message != nil }, set: { if !$0 { c.message = nil } })) { Button("OK") { c.message = nil } } message: { Text(c.message ?? "") }
        .alert("Action needs attention", isPresented: Binding(get: { c.error != nil }, set: { if !$0 { c.error = nil } })) { Button("OK") { c.error = nil } } message: { Text(c.error ?? "") }
    }
}
struct LinkStatus: View {
    @EnvironmentObject var c: RemoteConnection
    var body: some View { Label(c.connected ? "Connected to laptop" : "Laptop not connected", systemImage: c.connected ? "checkmark.circle" : "wifi.slash").font(.subheadline).foregroundStyle(c.connected ? .secondary : Color.orange).accessibilityLabel(c.connected ? "Connected to laptop" : "Disconnected. Open Connect and check the laptop URL.") }
}
private let choices: [(String, String, String, String)] = [
    ("sensor", "Temperature warning", "Rack A-11 · verify before acting", "thermometer.high"),
    ("water", "Water leak", "East corridor · inspect downstream risk", "drop.triangle"),
    ("heat", "Cooling failure", "Chiller 1 · compare response options", "fan"),
    ("vibration", "Fan vibration", "CRAH-2 · inspect mechanical health", "waveform.path")
]
struct DemoView: View {
    @EnvironmentObject var c: RemoteConnection
    @State private var chosen = "sensor"
    @State private var confirmReset = false
    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 24) {
            LinkStatus()
            VStack(alignment: .leading, spacing: 8) { Text("A warning.\nA clear next step.").font(.largeTitle.bold()); Text("Control the walkthrough from your iPhone. The laptop stays on the monitoring dashboard.").foregroundStyle(.secondary) }
            VStack(spacing: 0) { ForEach(choices, id: \.0) { item in
                Button { chosen = item.0 } label: { HStack(spacing: 14) { Image(systemName: item.3).font(.title2).frame(width: 28); VStack(alignment: .leading, spacing: 5) { Text(item.1).font(.headline); Text(item.2).font(.caption).foregroundStyle(.secondary) }; Spacer(); if chosen == item.0 { Image(systemName: "checkmark") } }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(chosen == item.0 ? Color(red: 0, green: 0.62, blue: 0.565).opacity(0.08) : Color(uiColor: .secondarySystemGroupedBackground)) }.buttonStyle(.plain)
                Divider()
            } }.clipShape(RoundedRectangle(cornerRadius: 14))
            Button { Task { _ = await c.send(["type": "simulate_error", "kind": chosen], confirmation: "Warning delivered to the laptop. Open Response to verify it, assign a technician and follow the checklist.") } } label: { Label(c.busy ? "Sending…" : "Simulate error", systemImage: "exclamationmark.triangle").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 12) }.buttonStyle(.borderedProminent).disabled(!c.connected || c.busy)
            Text("Demo only. Injects a labelled warning; never changes or damages physical equipment.").font(.caption).foregroundStyle(.secondary)
            if let s = c.snapshot { HStack { statusNumber("Open warnings", s.issues.filter { $0.status != "resolved" }.count); Spacer(); statusNumber("Need evidence", s.issues.filter { $0.status != "resolved" && $0.evidence == nil }.count) } }
            Button("Review handoff gaps") { Task { _ = await c.send(["type": "review"], confirmation: "Handoff checked. Open Handoff on the laptop for missing evidence, owners and incomplete steps.") } }.disabled(!c.connected || c.busy)
            Button("Start a new demo session", role: .destructive) { confirmReset = true }.font(.footnote).disabled(!c.connected || c.busy)
        }.padding(22) }.background(Color(uiColor: .systemGroupedBackground)).navigationTitle("CenterGuard").navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Clear this session's incidents and history? Export the laptop handoff first if needed.", isPresented: $confirmReset) { Button("Clear demo session", role: .destructive) { Task { _ = await c.send(["type": "reset"]) } } }
    }
    private func statusNumber(_ label: String, _ count: Int) -> some View { VStack(alignment: .leading, spacing: 4) { Text("\(count)").font(.title.bold()); Text(label).font(.caption).foregroundStyle(.secondary) } }
}
struct ConnectionView: View {
    @EnvironmentObject var c: RemoteConnection
    @Environment(\.dismiss) var dismiss
    var body: some View { NavigationStack { Form {
        Section("Laptop connection") { TextField("http://192.168.1.20:5173", text: $c.address).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL); TextField("Your name", text: $c.operatorName); LinkStatus(); Button("Test connection") { Task { await c.refresh(); if c.connected { dismiss() } else { c.error = "Cannot reach the laptop. Keep the bridge running, use its current private Wi-Fi address, join the same network, and allow Local Network access in iOS Settings." } } } }
        Section("Before presenting") { Text("On the laptop run RACKMON_SIM=1 npm run dev:lan for a fully simulated walkthrough. Use actual USB serial mode only with the matching prototype firmware."); Text("Keep both devices on the same trusted Wi-Fi. The bridge has no production login; do not expose it publicly.") }
    }.navigationTitle("Connect").toolbar { Button("Done") { dismiss() } } } }
}
struct ResponseList: View {
    @EnvironmentObject var c: RemoteConnection
    var body: some View { List {
        Section { LinkStatus() }
        if let snapshot = c.snapshot { ForEach(snapshot.issues.reversed()) { issue in NavigationLink { ResponseDetail(id: issue.id) } label: { VStack(alignment: .leading, spacing: 6) { Text(issue.title).font(.headline); Text(issue.location).font(.caption).foregroundStyle(.secondary); Text(issue.status == "resolved" ? "Closed" : issue.evidence?.verdict.replacingOccurrences(of: "_", with: " ") ?? "Needs independent evidence").font(.caption).foregroundStyle(issue.status == "resolved" ? Color.secondary : Color.orange) } } } }
        if c.snapshot?.issues.isEmpty != false { ContentUnavailableView("No warnings yet", systemImage: "checkmark.shield", description: Text("Trigger an incident from Controller. The laptop and iPhone share the same record.")) }
    }.navigationTitle("Team response").refreshable { await c.refresh() } }
}
private let crew: [(String, String, [String])] = [("emp-priya", "Priya Raman", ["sensor"]), ("emp-marcus", "Marcus Lee", ["sensor", "vibration"]), ("emp-amara", "Amara Singh", ["heat", "sensor"]), ("emp-jordan", "Jordan Kim", ["water", "sensor"]) ]
struct ResponseDetail: View {
    @EnvironmentObject var c: RemoteConnection
    let id: String
    @State private var outcome = ""
    var issue: RemoteIssue? { c.snapshot?.issues.first { $0.id == id } }
    var body: some View { Form { if let i = issue {
        Section { Text(i.title).font(.title3.bold()); Label(i.location, systemImage: "mappin.and.ellipse"); Text("Confirm the equipment label and service side before measuring.").font(.caption).foregroundStyle(.secondary) }
        Section("Independent verification") {
            LabeledContent("Installed · demo", value: String(format: "%.1f %@", i.installed, i.unit))
            if let e = i.evidence { LabeledContent("Portable · \(e.source)", value: String(format: "%.1f %@", e.value, e.unit)); Text(e.note).font(.caption) }
            Button("Collect portable sensor reading") { Task { await c.scan(i) } }.disabled(!c.connected || c.busy || (i.kind == "vibration" && c.snapshot?.prototype?.vibrating == nil) || i.status == "resolved")
            Text("Keep module steady for 10 seconds. A simulated bridge produces simulated evidence. Vibration requires the optional digital detector field; it is qualitative, not calibrated mm/s.").font(.caption).foregroundStyle(.secondary)
            DisclosureGroup("Use a scripted demo reference instead") { Button("Attach labelled demo reference") { Task { _ = await c.send(["type": "verify_fixture", "issueId": id]) } }.disabled(c.busy || !c.connected || i.status == "resolved"); Text("No physical measurement is taken.").font(.caption) }
        }
        Section("Assign and execute") {
            Menu { ForEach(crew.filter { $0.2.contains(i.kind) }, id: \.0) { person in Button(person.1) { Task { _ = await c.send(["type": "assign", "issueId": id, "employeeId": person.0]) } } } } label: { Label(crew.first { $0.0 == i.ownerId }?.1 ?? "Assign technician", systemImage: "person.crop.circle") }.disabled(c.busy || !c.connected || i.status == "resolved")
            ForEach(i.steps) { step in Button { Task { _ = await c.send(["type": "check", "issueId": id, "stepId": step.id, "done": !step.done]) } } label: { Label(step.label, systemImage: step.done ? "checkmark.square.fill" : "square").foregroundStyle(.primary) }.disabled(c.busy || !c.connected || i.ownerId == nil || step.id == "verify" || i.status == "resolved") }
        }
        Section("Outcome") {
            if let resolution = i.resolution { Text(resolution) } else { TextField("What changed, and what did the recheck show?", text: $outcome, axis: .vertical).lineLimit(3...5); Button("Close with evidence") { Task { _ = await c.send(["type": "resolve", "issueId": id, "note": outcome], confirmation: "Outcome recorded. The laptop history and handoff have been updated.") } }.disabled(c.busy || !c.connected || i.ownerId == nil || i.evidence == nil || i.evidence?.verdict == "inconclusive" || i.steps.contains { !$0.done } || outcome.trimmingCharacters(in: .whitespacesAndNewlines).count < 8) }
        }
    } }.navigationTitle("Incident").navigationBarTitleDisplayMode(.inline) }
}
struct SensorView: View {
    static func date(_ value: String, _ parser: ISO8601DateFormatter) -> Date {
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = parser.date(from: value) { return date }
        parser.formatOptions = [.withInternetDateTime]
        return parser.date(from: value) ?? .distantPast
    }
    @EnvironmentObject var c: RemoteConnection
    var body: some View { List {
        Section { LinkStatus() }
        if let frame = c.snapshot?.prototype {
            let parser = ISO8601DateFormatter()
            let date = Self.date(frame.at, parser)
            let fresh = Date().timeIntervalSince(date) < 6
            Section("\(frame.source == "live" ? "Physical" : "Simulated") module · \(frame.dev)") {
                LabeledContent("Frame status", value: fresh ? "Fresh" : "Stale — do not trust as current")
                LabeledContent("Temperature", value: fresh ? (frame.ref_c ?? frame.inlet_bottom_c).map { String(format: "%.1f °C", $0) } ?? "Unavailable" : "Unavailable")
                LabeledContent("Water probe", value: fresh ? "\(Int(frame.floor_raw)) raw ADC" : "Unavailable")
                LabeledContent("Vibration", value: fresh ? frame.vibrating.map { $0 ? "Detected (qualitative)" : "Quiet (qualitative)" } ?? "Channel unavailable" : "Unavailable")
                Text("This module measures one location. A scan associates its readings with a specific incident; it is not telemetry for every rack.").font(.caption).foregroundStyle(.secondary)
                ForEach(frame.flags, id: \.self) { Text($0).font(.caption) }
            }
        } else { ContentUnavailableView("No sensor frames", systemImage: "sensor", description: Text("Connect the laptop bridge and a compatible prototype, or use its clearly labelled simulator.")) }
    }.navigationTitle("Portable sensor") }
}
