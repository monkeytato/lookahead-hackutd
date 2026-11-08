import Foundation

/// `GET /api/phone` — one compact snapshot computed by the laptop bridge (server/phoneSummary.ts).
/// The phone never runs the engine; it only shows this and sends intents back.
struct PhoneSummary: Decodable, Equatable {
    let now: Double
    let stage: Stage
    let forecast: Forecast
    let clocks: [Clock]
    let problems: [Problem]
    let fixes: [OrderedFix]
    let rig: Rig
    let director: Director
    /// Monitored readings as dials (optional: older laptops don't send it)
    let gauges: [PhoneGauge]?
}

/// One monitored reading: value on a min–max scale with its normal band and alarm line.
struct PhoneGauge: Decodable, Equatable, Identifiable {
    let id: String
    let short: String
    let unit: String
    let value: Double?
    let min: Double
    let max: Double
    let normalLo: Double
    let normalHi: Double
    let warn: Double
    let alarm: Double
    let dir: String          // "above" | "below": which side is bad
    let severity: Severity
    let predicted: Double?

    func fraction(_ v: Double?) -> Double {
        guard let v, max > min else { return 0 }
        return Swift.min(1, Swift.max(0, (v - min) / (max - min)))
    }
}

struct Stage: Decodable, Equatable {
    let scenarioId: String
    let headline: String
    let kind: String          // "real" | "random" | "what-if"
    let basis: String
    let t: Double             // scenario minute
    let horizon: Double
    let wallClock: String     // "HH:MM"
    let playing: Bool
    let speed: Double
    let autoPause: Bool
    let lookaheadMin: Double
    let last: String
}

struct Forecast: Decodable, Equatable {
    let firstRackLossIn: Double?   // minutes from now (p50); nil = none ahead
    let firstRackAssetId: String?
    let racksTotal: Int
    let racksLost: Int
    let racksAtRisk: Int
    let assetsLost: Int
    let servicesAtRisk: Int
    let savedByFixes: Int
}

struct Clock: Decodable, Equatable, Identifiable {
    let assetId: String
    let name: String
    let inMin: Double
    let p10In: Double
    let p90In: Double
    let severity: Severity
    var id: String { assetId }
}

struct Problem: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    let severity: Severity
    let assetId: String
    let openedAt: Double
    let fixes: [FixOption]
}

struct FixOption: Decodable, Equatable, Identifiable {
    let action: String
    let assetId: String
    let label: String
    let delayMin: Double
    let savesRacks: Int
    let savesAssets: Int
    var id: String { "\(action)|\(assetId)" }
}

struct OrderedFix: Decodable, Equatable, Identifiable {
    let id: String
    let label: String
    let assetId: String
    let orderedAt: Double
    let effectiveAt: Double
    let inEffect: Bool
}

struct Rig: Decodable, Equatable {
    let mode: String          // "serial" | "simulated" | "disconnected"
    let inletC: Double?
    let outletC: Double?
    let referenceC: Double?
    let deltaC: Double?
    let floorWet: Bool?
    let ageS: Double?
}

struct Director: Decodable, Equatable {
    let configured: Bool
    let model: String
}

/// ISA-101: color is reserved for abnormal states. Unknown values decode as `.normal`.
enum Severity: String, Decodable, Equatable, Comparable {
    case normal, advisory, warning, critical

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Severity(rawValue: raw) ?? .normal
    }

    private var rank: Int {
        switch self {
        case .normal: return 0
        case .advisory: return 1
        case .warning: return 2
        case .critical: return 3
        }
    }

    static func < (a: Severity, b: Severity) -> Bool { a.rank < b.rank }

    /// Same thresholds as the web engine: ≤ 10 min critical, ≤ 30 min warning.
    static func forMinutesLeft(_ m: Double?) -> Severity {
        guard let m else { return .normal }
        if m <= 10 { return .critical }
        if m <= 30 { return .warning }
        return .normal
    }
}

extension PhoneSummary {
    static func decode(_ data: Data) throws -> PhoneSummary {
        try JSONDecoder().decode(PhoneSummary.self, from: data)
    }
}
