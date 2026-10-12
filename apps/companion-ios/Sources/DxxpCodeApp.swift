import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @Published var pair: PairInfo? {
        didSet { api = pair.map(DxxpAPI.init) }
    }
    @Published var api: DxxpAPI?
    @Published var health: DxxpAPI.Health?
    @Published var deepLinkTask: String?
    @Published var navPath = NavigationPath()

    init() {
        pair = PairStore.load()
        // Debug affordance: `xcrun simctl launch … -PAIR 'dxxpcode://pair?…'`
        // auto-pairs, which makes the app testable headless in a simulator.
        if let i = ProcessInfo.processInfo.arguments.firstIndex(of: "-PAIR"),
           let url = URL(string: ProcessInfo.processInfo.arguments[safe: i + 1] ?? ""),
           let p = PairInfo(url: url) {
            pair(p)
        }
        // `-OPEN <task_id>` deep-links straight into a task transcript.
        if let i = ProcessInfo.processInfo.arguments.firstIndex(of: "-OPEN") {
            deepLinkTask = ProcessInfo.processInfo.arguments[safe: i + 1]
        }
    }

    func pair(_ p: PairInfo) {
        PairStore.save(p)
        pair = p
        Task { health = try? await api?.health() }
    }

    func unpair() {
        PairStore.clear()
        pair = nil
        health = nil
    }
}

extension Array {
    subscript(safe i: Index) -> Element? { indices.contains(i) ? self[i] : nil }
}

@main
struct DxxpCodeCompanionApp: App {
    @StateObject private var app = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var app: AppModel
    @AppStorage("appearance") private var appearance = Appearance.system.rawValue

    var body: some View {
        Group {
            if app.pair == nil {
                PairView()
            } else {
                NavigationStack(path: $app.navPath) {
                    TaskListView()
                }
            }
        }
        .background(Color.dxBg.ignoresSafeArea())
        .preferredColorScheme(Appearance(rawValue: appearance)?.scheme)
    }
}
