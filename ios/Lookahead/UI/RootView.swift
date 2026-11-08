import SwiftUI

/// One screen: what's happening, how long we have, what to do. The laptop holds everything else.
struct RootView: View {
    @Environment(PhoneStore.self) private var store
    @State private var showSettings = false
    @State private var fixFor: Problem?

    var body: some View {
        NavigationStack {
            Group {
                if let s = store.summary {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 20) {
                            Header(summary: s)
                            // Monitor first: the hour-glass dial only appears when racks are actually threatened.
                            if s.forecast.firstRackLossIn != nil || s.forecast.racksLost > 0 || s.gauges == nil {
                                HeroDial(forecast: s.forecast, clocks: s.clocks)
                            }
                            if let gauges = s.gauges, !gauges.isEmpty {
                                GaugeGrid(gauges: gauges)
                            } else {
                                HStack(spacing: 12) {
                                    RacksDial(forecast: s.forecast)
                                    InletDial(rig: s.rig)
                                }
                            }
                            if s.forecast.savedByFixes > 0 {
                                Label("Your fixes saved \(s.forecast.savedByFixes) rack\(s.forecast.savedByFixes == 1 ? "" : "s")", systemImage: "checkmark.circle.fill")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(Theme.good)
                            }
                            ProblemsSection(problems: s.problems, fixes: s.fixes, t: s.stage.t) { fixFor = $0 }
                            Text(s.stage.basis)
                                .font(.footnote)
                                .foregroundStyle(.tertiary)
                                .padding(.top, 4)
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 4)
                        .padding(.bottom, 120)
                    }
                    .scrollIndicators(.hidden)
                    .safeAreaInset(edge: .bottom) { ControlBar(stage: s.stage) }
                } else {
                    NotConnected(showSettings: $showSettings)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { LinkBadge() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "slider.horizontal.3") }
                        .accessibilityLabel("Settings")
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(item: $fixFor) { FixSheet(problem: $0) }
        .overlay(alignment: .top) { NoticeBanner() }
        .task { await store.run() }
    }
}

// MARK: - Header

private struct Header: View {
    let summary: PhoneSummary

    var body: some View {
        let st = summary.stage
        VStack(alignment: .leading, spacing: 8) {
            Text(Format.kindLabel(st.kind)).eyebrow()
            Text(st.headline)
                .font(.system(size: 26, weight: .semibold))
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Text(st.wallClock).font(Theme.number(17, weight: .medium))
                Text("\(Format.scenarioMinute(st.t)) of \(Int(st.horizon)) min").font(Theme.number(15, weight: .regular)).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                StateChip(stage: st)
            }
            if st.lookaheadMin > 0 {
                Label("Showing prediction +\(Int(st.lookaheadMin)) min on the big screen", systemImage: "eye")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct StateChip: View {
    let stage: Stage
    var body: some View {
        let ended = stage.t >= stage.horizon
        let text = ended ? "Ended" : stage.playing ? (stage.speed == 1 ? "Playing" : "Playing \(stage.speed.formatted())×") : "Paused"
        Text(text)
            .font(.system(size: 12, weight: .semibold))
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(Capsule().strokeBorder(Theme.hairline, lineWidth: 1))
            .foregroundStyle(stage.playing && !ended ? Color.primary : Color.secondary)
    }
}

// MARK: - Dials

/// The one number that matters most: minutes until the first rack is lost.
private struct HeroDial: View {
    let forecast: Forecast
    let clocks: [Clock]
    /// Full arc = an hour or more left; the arc runs down as the loss gets closer.
    private let windowMin = 60.0

    var body: some View {
        let left = forecast.firstRackLossIn
        let sev = Severity.forMinutesLeft(left)
        VStack(spacing: 14) {
            Dial(fraction: left.map { $0 / windowMin } ?? 1, tone: Theme.tone(sev), lineWidth: 12) {
                VStack(spacing: 2) {
                    if let left {
                        Text(Format.minutes(left))
                            .font(Theme.number(76, weight: .thin))
                            .foregroundStyle(sev == .normal ? Color.primary : Theme.tone(sev))
                            .contentTransition(.numericText(value: left))
                        Text("min to first rack loss").font(.footnote).foregroundStyle(.secondary)
                        if let id = forecast.firstRackAssetId {
                            Text(id).font(Theme.number(13, weight: .medium)).foregroundStyle(.secondary)
                        }
                    } else {
                        Text(forecast.racksLost > 0 ? "—" : "Clear")
                            .font(.system(size: 44, weight: .light))
                        Text(forecast.racksLost > 0 ? "No further rack loss ahead" : "No rack loss ahead")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .padding(28)
            }
            .frame(maxWidth: 280)
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)

            if !clocks.isEmpty {
                HStack(spacing: 0) {
                    ForEach(clocks.prefix(3)) { c in
                        VStack(spacing: 2) {
                            Text(c.assetId).font(Theme.number(13, weight: .medium))
                            Text("\(Format.minutes(c.inMin)) min").font(Theme.number(15, weight: .regular))
                                .foregroundStyle(c.severity >= .warning ? Theme.tone(c.severity) : .secondary)
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .panel(padding: 20)
    }
}

private struct RacksDial: View {
    let forecast: Forecast
    var body: some View {
        let total = max(1, forecast.racksTotal)
        let atRisk = forecast.racksAtRisk
        let sev: Severity = atRisk == 0 ? .normal : Double(atRisk) / Double(total) > 0.5 ? .critical : .warning
        VStack(alignment: .leading, spacing: 10) {
            Text("Racks at risk").eyebrow()
            Dial(fraction: Double(atRisk) / Double(total), tone: Theme.tone(sev), lineWidth: 8) {
                VStack(spacing: 0) {
                    Text("\(atRisk)").font(Theme.number(34, weight: .light))
                    Text("of \(forecast.racksTotal)").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: 130).frame(maxWidth: .infinity)
            Text(forecast.racksLost > 0 ? "\(forecast.racksLost) already lost" : "None lost yet")
                .font(.caption).foregroundStyle(forecast.racksLost > 0 ? Theme.tone(.critical) : .secondary)
        }
        .panel()
    }
}

private struct InletDial: View {
    let rig: Rig
    var body: some View {
        let c = rig.inletC
        let sev = Format.inletSeverity(c)
        VStack(alignment: .leading, spacing: 10) {
            Text("Rack inlet").eyebrow()
            // 15–40 °C scale; tick at 27 °C, the top of the ASHRAE recommended band
            Dial(fraction: Format.inletFraction(c), tone: Theme.tone(sev), lineWidth: 8, mark: Format.inletFraction(27)) {
                VStack(spacing: 0) {
                    Text(Format.celsius(c)).font(Theme.number(30, weight: .light))
                    Text("°C").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: 130).frame(maxWidth: .infinity)
            Text(rigCaption).font(.caption).foregroundStyle(rig.floorWet == true ? Theme.tone(.critical) : .secondary)
        }
        .panel()
    }

    private var rigCaption: String {
        if rig.floorWet == true { return "Floor probe wet" }
        switch rig.mode {
        case "serial": return "Rack Monitor · live"
        case "simulated": return "Rack Monitor · simulated"
        default: return "Rig not connected"
        }
    }
}

// MARK: - Connection

private struct LinkBadge: View {
    @Environment(PhoneStore.self) private var store
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text).font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
    private var text: String {
        switch store.link {
        case .live: return "Live"
        case .connecting: return "Connecting"
        case .offline: return "Offline"
        case .sample: return "Sample data"
        case .notSet: return "Not set up"
        }
    }
    private var color: Color {
        switch store.link {
        case .live: return Theme.good
        case .offline: return Theme.tone(.warning)
        default: return Color.secondary.opacity(0.6)
        }
    }
}

private struct NotConnected: View {
    @Environment(PhoneStore.self) private var store
    @Binding var showSettings: Bool

    var body: some View {
        VStack(spacing: 18) {
            Dial(fraction: 0, tone: .clear, lineWidth: 10) { Image(systemName: "laptopcomputer").font(.system(size: 34, weight: .light)).foregroundStyle(.secondary) }
                .frame(width: 140)
            Text(title).font(.title3.weight(.semibold))
            Text(detail)
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Connect to laptop") { showSettings = true }
                .buttonStyle(.borderedProminent).controlSize(.large)
            Button("Look around with sample data") { store.setUseSample(true) }
                .font(.subheadline)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var title: String {
        switch store.link {
        case .connecting: return "Connecting…"
        case .offline: return "Can't reach the laptop"
        default: return "Connect to the laptop"
        }
    }
    private var detail: String {
        if case .offline(let why) = store.link { return why }
        return "On the laptop run npm run dev:lan, then enter its Network address here. Both devices on the same Wi-Fi."
    }
}

private struct NoticeBanner: View {
    @Environment(PhoneStore.self) private var store
    var body: some View {
        if let n = store.notice {
            Text(n)
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(.thinMaterial, in: Capsule())
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
                .task(id: n) {
                    try? await Task.sleep(nanoseconds: 2_600_000_000)
                    withAnimation { store.notice = nil }
                }
        }
    }
}

#Preview {
    RootView().environment(PhoneStore())
}
