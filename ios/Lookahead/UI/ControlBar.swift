import SwiftUI

/// Floating capsule: back 5 · play/pause · forward 5 · spawn disaster · prediction.
struct ControlBar: View {
    @Environment(PhoneStore.self) private var store
    let stage: Stage

    var body: some View {
        HStack(spacing: 6) {
            icon("gobackward.5", "Back 5 minutes") { store.jump(-5) }
            Button {
                store.togglePlay()
                tap()
            } label: {
                Image(systemName: stage.playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .frame(width: 58, height: 58)
                    .background(Circle().fill(Color.primary))
                    .foregroundStyle(Color(.systemBackground))
                    .contentTransition(.symbolEffect(.replace))
            }
            .accessibilityLabel(stage.playing ? "Pause" : "Play")
            icon("goforward.5", "Forward 5 minutes") { store.jump(5) }

            Divider().frame(height: 28).padding(.horizontal, 4)

            icon("exclamationmark.triangle", "Spawn disaster") { store.randomDisaster() }
            Menu {
                Picker("Prediction", selection: Binding(get: { Int(stage.lookaheadMin) }, set: { store.setLookahead(Double($0)) })) {
                    Text("Off").tag(0)
                    Text("+10 min").tag(10)
                    Text("+20 min").tag(20)
                    Text("+30 min").tag(30)
                }
            } label: {
                Image(systemName: stage.lookaheadMin > 0 ? "eye.fill" : "eye")
                    .font(.system(size: 19, weight: .regular))
                    .frame(width: 46, height: 46)
            }
            .accessibilityLabel("Prediction")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 1))
        .disabled(!store.canControl)
        .opacity(store.canControl ? 1 : 0.45)
        .padding(.bottom, 8)
    }

    private func icon(_ name: String, _ label: String, _ action: @escaping () -> Void) -> some View {
        Button {
            action()
            tap()
        } label: {
            Image(systemName: name)
                .font(.system(size: 19, weight: .regular))
                .frame(width: 46, height: 46)
        }
        .accessibilityLabel(label)
        .tint(.primary)
    }

    private func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
}
