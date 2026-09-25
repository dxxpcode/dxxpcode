import SwiftUI

@main
struct DxxpCodeApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup("DxxpCode") {
            ContentView()
                .environment(model)
                .frame(minWidth: 960, minHeight: 600)
                .background(WindowAccessor())
        }
        .defaultSize(width: 1200, height: 800)
        .commands { AppCommands(model: model) }

        Settings {
            SettingsView()
                .environment(model)
        }
    }
}
