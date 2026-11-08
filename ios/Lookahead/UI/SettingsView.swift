import SwiftUI

struct SettingsView: View {
    @Environment(PhoneStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @FocusState private var editing: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("192.168.1.20:5173", text: $address)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(Theme.number(17, weight: .regular))
                        .focused($editing)
                        .submitLabel(.done)
                        .onSubmit(save)
                    Button("Connect", action: save)
                        .disabled(BridgeClient.baseURL(from: address) == nil)
                } header: {
                    Text("Laptop address")
                } footer: {
                    Text("On the laptop run npm run dev:lan and use the Network address it prints. Both devices must be on the same Wi-Fi.")
                }

                Section("Status") {
                    LabeledContent("Connection", value: linkText)
                    if let s = store.summary, !store.useSample {
                        LabeledContent("Scenario", value: s.stage.scenarioId)
                        LabeledContent("Director", value: s.director.configured ? "Nemotron" : "Local planner")
                    }
                }

                if let s = store.summary, store.canControl {
                    Section {
                        Toggle("Pause on each new incident", isOn: Binding(get: { s.stage.autoPause }, set: { store.setAutoPause($0) }))
                    } footer: {
                        Text("Every screen stops when an alarm fires, so you can explain it and order a fix.")
                    }
                }

                Section {
                    Toggle("Use sample data", isOn: Binding(get: { store.useSample }, set: { store.setUseSample($0) }))
                } footer: {
                    Text("A saved snapshot for looking around without the laptop. Controls are off in this mode.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { save(); dismiss() } } }
            .onAppear { address = store.address }
        }
    }

    private func save() {
        guard address != store.address else { return }
        store.setAddress(address)
        if store.useSample { store.setUseSample(false) }
        Task { await store.refresh() }
    }

    private var linkText: String {
        switch store.link {
        case .live: return "Live"
        case .connecting: return "Connecting…"
        case .offline(let why): return why
        case .sample: return "Sample data"
        case .notSet: return "Not set up"
        }
    }
}
