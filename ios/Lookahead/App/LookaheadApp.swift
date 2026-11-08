import SwiftUI

@main
struct LookaheadApp: App {
    @State private var store = PhoneStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
        }
    }
}
