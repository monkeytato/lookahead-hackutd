import SwiftUI

/// Monitored readings as small dials: shaded normal band, alarm tick, value arc, and a hollow
/// marker where the engine predicts the reading will be.
struct GaugeGrid: View {
    let gauges: [PhoneGauge]
    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Readings").eyebrow()
                Spacer()
                let bad = gauges.filter { $0.severity >= .warning }.count
                Text(bad == 0 ? "All normal" : "\(bad) abnormal")
                    .font(Theme.caption)
                    .foregroundStyle(bad == 0 ? Color.secondary : Theme.tone(.warning))
            }
            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(gauges) { GaugeCell(gauge: $0) }
            }
        }
    }
}

private struct GaugeCell: View {
    let gauge: PhoneGauge

    var body: some View {
        let g = gauge
        VStack(alignment: .leading, spacing: 8) {
            Text(g.short).font(.subheadline.weight(.medium)).lineLimit(1)
            ZStack {
                BandArc(from: g.fraction(g.normalLo), to: g.fraction(g.normalHi))
                    .stroke(Theme.tone(.normal).opacity(0.18), style: StrokeStyle(lineWidth: 14, lineCap: .butt))
                Dial(fraction: g.fraction(g.value), tone: Theme.tone(g.severity), lineWidth: 6, mark: g.fraction(g.alarm)) {
                    VStack(spacing: 0) {
                        Text(valueText).font(Theme.number(26, weight: .light))
                        Text(g.unit).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                if let p = g.predicted, abs(g.fraction(p) - g.fraction(g.value)) > 0.01 {
                    Marker(fraction: g.fraction(p))
                        .stroke(Color.primary.opacity(0.6), style: StrokeStyle(lineWidth: 1.5, dash: [2, 2]))
                }
            }
            .aspectRatio(1, contentMode: .fit)
            .frame(maxWidth: 120)
            .frame(maxWidth: .infinity)
            Text(caption).font(.caption).foregroundStyle(g.severity >= .warning ? Theme.tone(g.severity) : .secondary).lineLimit(1)
        }
        .panel(padding: 14)
        .accessibilityElement(children: .combine)
    }

    private var valueText: String {
        guard let v = gauge.value else { return "—" }
        return abs(v) >= 100 ? String(Int(v.rounded())) : String(format: "%.1f", v)
    }

    private var caption: String {
        let g = gauge
        if let p = g.predicted, let v = g.value, abs(p - v) >= 0.1 {
            return "→ \(String(format: "%.1f", p)) predicted"
        }
        return "Normal \(fmt(g.normalLo))–\(fmt(g.normalHi))"
    }

    private func fmt(_ v: Double) -> String { v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v) }
}

/// The normal band, drawn on the same 270° geometry as Dial.
private struct BandArc: Shape {
    var from: Double
    var to: Double
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let r = min(rect.width, rect.height) / 2 - 3
        guard to > from else { return p }
        p.addArc(center: CGPoint(x: rect.midX, y: rect.midY), radius: r,
                 startAngle: .degrees(135 + 270 * from), endAngle: .degrees(135 + 270 * to), clockwise: false)
        return p
    }
}

/// A small hollow circle on the arc at the predicted value.
private struct Marker: Shape {
    var fraction: Double
    func path(in rect: CGRect) -> Path {
        let r = min(rect.width, rect.height) / 2 - 3
        let a = Angle.degrees(135 + 270 * fraction).radians
        let c = CGPoint(x: rect.midX + r * CGFloat(cos(a)), y: rect.midY + r * CGFloat(sin(a)))
        return Path(ellipseIn: CGRect(x: c.x - 6, y: c.y - 6, width: 12, height: 12))
    }
}
