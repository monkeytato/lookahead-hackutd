import SwiftUI

/// "Needs attention": at most a few problems, each with one clear action.
struct ProblemsSection: View {
    let problems: [Problem]
    let fixes: [OrderedFix]
    let t: Double
    var onFix: (Problem) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Needs attention").eyebrow()
            if problems.isEmpty && fixes.isEmpty {
                Text("Nothing needs attention right now.")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .panel()
            }
            ForEach(problems) { p in
                ProblemRow(problem: p, t: t) { onFix(p) }
            }
            ForEach(fixes) { f in
                FixRow(fix: f, t: t)
            }
        }
    }
}

private struct ProblemRow: View {
    let problem: Problem
    let t: Double
    var onFix: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            Capsule()
                .fill(Theme.tone(problem.severity))
                .frame(width: 4)
                .frame(maxHeight: .infinity)
            VStack(alignment: .leading, spacing: 4) {
                Text(problem.title)
                    .font(.body.weight(.medium))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(problem.assetId) · \(openedText)")
                    .font(Theme.number(13, weight: .regular))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if !problem.fixes.isEmpty {
                Button("Fix", action: onFix)
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.regular)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .panel(padding: 14)
    }

    private var openedText: String {
        let ago = Int((t - problem.openedAt).rounded(.down))
        return ago <= 0 ? "just now" : "\(ago) min ago"
    }
}

private struct FixRow: View {
    let fix: OrderedFix
    let t: Double

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: fix.inEffect ? "checkmark.circle.fill" : "clock")
                .foregroundStyle(fix.inEffect ? Theme.good : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(fix.label).font(.subheadline.weight(.medium)).lineLimit(2)
                Text(status).font(Theme.number(13, weight: .regular)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .panel(padding: 14)
    }

    private var status: String {
        if fix.inEffect { return "In effect" }
        let left = fix.effectiveAt - t
        return left <= 0 ? "Taking effect" : "Ordered · in effect in \(Format.minutes(left)) min"
    }
}

/// Choose a fix. The laptop predicted what each one saves; ordering is one tap.
struct FixSheet: View {
    @Environment(PhoneStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let problem: Problem

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text(problem.title)
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(problem.fixes) { f in
                    VStack(alignment: .leading, spacing: 12) {
                        Text(f.label).font(.body.weight(.medium)).fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 18) {
                            Fact(value: "~\(Format.minutes(f.delayMin)) min", label: "to take effect")
                            Fact(value: f.savesRacks > 0 ? "\(f.savesRacks)" : "—", label: f.savesRacks == 1 ? "rack saved" : "racks saved",
                                 tint: f.savesRacks > 0 ? Theme.good : nil)
                        }
                        Button {
                            store.order(f)
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            dismiss()
                        } label: {
                            Text("Order this fix").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(!store.canControl)
                    }
                    .panel()
                }
                if !store.canControl {
                    Text("Connect to the laptop to order fixes.").font(.footnote).foregroundStyle(.secondary)
                }
                Text("Savings are the engine's prediction on the laptop, not an observation.")
                    .font(.footnote).foregroundStyle(.tertiary)
                Spacer(minLength: 0)
            }
            .padding(20)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Close") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

private struct Fact: View {
    let value: String
    let label: String
    var tint: Color? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(value).font(Theme.number(22, weight: .regular)).foregroundStyle(tint ?? .primary)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
    }
}
