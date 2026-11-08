import Foundation

/// Plain-language formatting shared by the views (no SwiftUI here, so it is unit-testable).
enum Format {
    /// 7.4 → "7", 0.4 → "<1"
    static func minutes(_ m: Double) -> String {
        if m < 1 { return "<1" }
        return String(Int(m.rounded()))
    }

    /// "T+25"
    static func scenarioMinute(_ t: Double) -> String { "T+\(Int(t.rounded(.down)))" }

    /// "22.5°"
    static func celsius(_ c: Double?) -> String {
        guard let c else { return "—" }
        return String(format: "%.1f°", c)
    }

    /// Range only when it says something: (12–18), never (15–15).
    static func range(_ lo: Double, _ hi: Double) -> String? {
        let a = Int(lo.rounded()), b = Int(hi.rounded())
        return a == b ? nil : "\(a)–\(b) min"
    }

    static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "real": return "Real incident · simulated"
        case "random": return "Random disaster"
        default: return "What-if"
        }
    }

    /// 0…1 position of an inlet temperature on a 15–40 °C dial.
    static func inletFraction(_ c: Double?) -> Double {
        guard let c else { return 0 }
        return min(1, max(0, (c - 15) / 25))
    }

    /// ASHRAE A1: recommended ≤ 27 °C, allowable ≤ 32 °C (same thresholds as the web app).
    static func inletSeverity(_ c: Double?) -> Severity {
        guard let c else { return .normal }
        if c > 32 { return .critical }
        if c > 27 { return .warning }
        return .normal
    }
}
