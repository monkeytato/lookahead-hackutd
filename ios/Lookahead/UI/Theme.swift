import SwiftUI

/// Quiet by default. Color appears only when something is abnormal (ISA-101), the same rule as the
/// web dashboard: gray when normal, amber for a warning, red for critical.
enum Theme {
    static let card = Color(.secondarySystemBackground)
    static let track = Color.primary.opacity(0.08)
    static let hairline = Color.primary.opacity(0.08)
    static let good = Color(red: 0.14, green: 0.63, blue: 0.40)

    static func tone(_ s: Severity) -> Color {
        switch s {
        case .critical: return Color(red: 0.90, green: 0.22, blue: 0.21)
        case .warning: return Color(red: 0.95, green: 0.62, blue: 0.10)
        case .advisory, .normal: return Color.primary.opacity(0.55)
        }
    }

    static func number(_ size: CGFloat, weight: Font.Weight = .light) -> Font {
        .system(size: size, weight: weight).monospacedDigit()
    }

    static let caption = Font.system(size: 12, weight: .medium)
}

extension View {
    /// A plain rounded panel; no shadows.
    func panel(padding: CGFloat = 16) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    /// Small uppercase label with a little tracking.
    func eyebrow() -> some View {
        self.font(Theme.caption).tracking(0.8).textCase(.uppercase).foregroundStyle(.secondary)
    }
}
