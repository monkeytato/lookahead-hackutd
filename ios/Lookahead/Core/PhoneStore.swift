import Foundation
import Observation

/// App state: polls the laptop once a second and forwards the presenter's actions.
/// All numbers come from the laptop; nothing is computed or invented here.
@MainActor
@Observable
final class PhoneStore {
    enum Link: Equatable {
        case notSet          // no address yet
        case connecting
        case live
        case offline(String) // last error, shown in plain words
        case sample          // bundled sample data, controls disabled
    }

    private(set) var summary: PhoneSummary?
    private(set) var link: Link = .notSet
    private(set) var lastUpdate: Date?
    private(set) var busy = false
    /// Short-lived message after an action ("Fix ordered", or an error)
    var notice: String?

    private(set) var address: String
    private(set) var useSample: Bool

    private static let addressKey = "lookahead.address"
    private static let sampleKey = "lookahead.useSample"

    init(defaults: UserDefaults = .standard) {
        address = defaults.string(forKey: Self.addressKey) ?? ""
        useSample = defaults.bool(forKey: Self.sampleKey)
        if useSample { loadSample() }
    }

    var client: BridgeClient? { BridgeClient.baseURL(from: address).map { BridgeClient(base: $0) } }
    var canControl: Bool { link == .live && !useSample }

    // MARK: settings

    func setAddress(_ value: String) {
        address = value.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(address, forKey: Self.addressKey)
        if !useSample { link = address.isEmpty ? .notSet : .connecting }
    }

    func setUseSample(_ on: Bool) {
        useSample = on
        UserDefaults.standard.set(on, forKey: Self.sampleKey)
        if on { loadSample() } else { summary = nil; link = address.isEmpty ? .notSet : .connecting }
    }

    // MARK: polling

    /// Runs for as long as the calling `.task` lives (SwiftUI cancels it when the view goes away).
    func run() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }

    func refresh() async {
        guard !useSample else { return }
        guard let client else { link = .notSet; return }
        if summary == nil, link != .live { link = .connecting }
        do {
            let s = try await client.summary()
            summary = s
            lastUpdate = Date()
            link = .live
        } catch {
            if Task.isCancelled { return }
            link = .offline(Self.plain(error))
        }
    }

    // MARK: actions (laptop decides; we show what it answers)

    func togglePlay() { guard let s = summary else { return }; send(s.stage.playing ? .pause : .play) }
    func jump(_ minutes: Double) { send(.jump(minutes)) }
    func setLookahead(_ minutes: Double) { send(.lookahead(minutes)) }
    func setAutoPause(_ on: Bool) { send(.autoPause(on)) }

    func randomDisaster() {
        perform("Disaster spawned") { client in try await client.randomDisaster() }
    }

    func order(_ fix: FixOption) {
        perform("Fix ordered: \(fix.label)") { client in try await client.orderFix(fix) }
    }

    private func send(_ cmd: StageCommand) {
        guard canControl, let client else { notice = useSample ? "Sample data — connect to the laptop to control." : "Not connected."; return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await client.stage(cmd)
                await refresh()
            } catch {
                notice = Self.plain(error)
            }
        }
    }

    private func perform(_ done: String, _ call: @escaping (BridgeClient) async throws -> PhoneSummary) {
        guard canControl, let client else { notice = useSample ? "Sample data — connect to the laptop to control." : "Not connected."; return }
        busy = true
        Task {
            defer { busy = false }
            do {
                summary = try await call(client)
                lastUpdate = Date()
                notice = done
            } catch {
                notice = Self.plain(error)
            }
        }
    }

    // MARK: sample data (offline preview, also used by SwiftUI previews)

    private func loadSample() {
        summary = Self.sample
        link = .sample
    }

    static var sample: PhoneSummary? {
        guard let url = Bundle.main.url(forResource: "phone-sample", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? PhoneSummary.decode(data)
    }

    private static func plain(_ error: Error) -> String {
        if let e = error as? URLError {
            switch e.code {
            case .timedOut: return "The laptop didn't answer in time."
            case .cannotConnectToHost, .cannotFindHost: return "Can't reach the laptop. Same Wi-Fi? Is npm run dev:lan running?"
            case .notConnectedToInternet: return "This phone isn't on a network."
            default: return e.localizedDescription
            }
        }
        if error is DecodingError { return "The laptop sent data this app version doesn't understand. Pull the latest code on both." }
        return error.localizedDescription
    }
}
