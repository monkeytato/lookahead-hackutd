import SwiftUI

/// A 270° arc gauge: thin track, rounded progress cap, optional threshold tick, content in the middle.
struct Dial<Center: View>: View {
    /// 0…1
    var fraction: Double
    var tone: Color
    var lineWidth: CGFloat = 10
    /// Optional threshold mark (0…1), e.g. the 27 °C line on the inlet dial
    var mark: Double? = nil
    @ViewBuilder var center: () -> Center

    var body: some View {
        ZStack {
            Arc(fraction: 1, inset: lineWidth / 2)
                .stroke(Theme.track, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
            Arc(fraction: fraction.clamped01, inset: lineWidth / 2)
                .stroke(tone, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
            if let mark {
                Tick(fraction: mark.clamped01, inset: lineWidth / 2, length: lineWidth + 6)
                    .stroke(Color.primary.opacity(0.35), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            }
            center()
        }
        .aspectRatio(1, contentMode: .fit)
        .animation(.smooth(duration: 0.6), value: fraction)
        .animation(.smooth(duration: 0.4), value: tone)
    }
}

/// Arc from 135° clockwise through 270° (open at the bottom), drawn up to `fraction`.
private struct Arc: Shape {
    var fraction: Double
    var inset: CGFloat

    var animatableData: Double {
        get { fraction }
        set { fraction = newValue }
    }

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let r = min(rect.width, rect.height) / 2 - inset
        guard r > 0, fraction > 0.0005 else { return p }
        p.addArc(center: CGPoint(x: rect.midX, y: rect.midY), radius: r,
                 startAngle: .degrees(135), endAngle: .degrees(135 + 270 * fraction), clockwise: false)
        return p
    }
}

/// A short radial line across the track at `fraction`.
private struct Tick: Shape {
    var fraction: Double
    var inset: CGFloat
    var length: CGFloat

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let r = min(rect.width, rect.height) / 2 - inset
        let a = Angle.degrees(135 + 270 * fraction).radians
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let dx = CGFloat(cos(a)), dy = CGFloat(sin(a))
        p.move(to: CGPoint(x: c.x + (r - length / 2) * dx, y: c.y + (r - length / 2) * dy))
        p.addLine(to: CGPoint(x: c.x + (r + length / 2) * dx, y: c.y + (r + length / 2) * dy))
        return p
    }
}

private extension Double {
    var clamped01: Double { Swift.min(1, Swift.max(0, self)) }
}

#Preview {
    HStack(spacing: 24) {
        Dial(fraction: 0.72, tone: Theme.tone(.normal)) { Text("43").font(Theme.number(40)) }
        Dial(fraction: 0.12, tone: Theme.tone(.critical), lineWidth: 8, mark: 0.48) { Text("7").font(Theme.number(32)) }
    }
    .padding()
}
