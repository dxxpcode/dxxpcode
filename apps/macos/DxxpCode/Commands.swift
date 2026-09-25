import SwiftUI

/// Focused-value plumbing so Agent menu commands act on the session
/// currently shown in the window.
struct FocusedSessionKey: FocusedValueKey {
    typealias Value = SessionModel
}

extension FocusedValues {
    var session: SessionModel? {
        get { self[FocusedSessionKey.self] }
        set { self[FocusedSessionKey.self] = newValue }
    }
}

struct AppCommands: Commands {
    let model: AppModel
    @FocusedValue(\.session) private var session

    var body: some Commands {
        CommandGroup(replacing: .appInfo) {
            Button("About DxxpCode") {
                NSApp.orderFrontStandardAboutPanel(options: [
                    .applicationName: "DxxpCode",
                    .applicationVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
                ])
            }
        }

        CommandGroup(replacing: .newItem) {
            Button("New Session") {
                model.selectedSessionId = nil
            }
            .keyboardShortcut("n")

            Button("Open Project…") {
                OpenProjectPanel.open { url in
                    Task { await model.openProject(at: url) }
                }
            }
            .keyboardShortcut("o")
        }

        CommandMenu("Agent") {
            Button("Approve") { session?.approvePlan(true); respondIfApproval(true) }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!(session?.pendingPlan != nil || session?.pendingApproval != nil))

            Button("Deny") { session?.approvePlan(false); respondIfApproval(false) }
                .keyboardShortcut(".", modifiers: .command)
                .disabled(!(session?.pendingPlan != nil || session?.pendingApproval != nil))

            Divider()

            Button("Cancel Run") { session?.cancel() }
                .keyboardShortcut(".", modifiers: [.command, .shift])
                .disabled(!(session?.running ?? false))

            Button("Undo to Checkpoint") {
                Task { _ = await session?.undoToCheckpoint() }
            }
            .keyboardShortcut("z", modifiers: [.command, .option])
            .disabled(session?.checkpoints.isEmpty ?? true)

            Divider()

            Button("Resume Last Session") {
                if let last = model.selectedProject?.sessions.first {
                    model.selectedSessionId = last.id
                }
            }
            .keyboardShortcut("r", modifiers: [.command, .shift])
            .disabled(model.selectedProject?.sessions.isEmpty ?? true)
        }

        CommandGroup(after: .sidebar) {
            Button("Larger Text") { TextScale.increase() }
                .keyboardShortcut("+", modifiers: .command)
            Button("Smaller Text") { TextScale.decrease() }
                .keyboardShortcut("-", modifiers: .command)
            Button("Actual Size") { TextScale.reset() }
                .keyboardShortcut("0", modifiers: .command)
        }

        CommandGroup(replacing: .help) {
            Button("DxxpCode Help") {
                if let url = URL(string: "https://dxxpcode.vercel.app") {
                    NSWorkspace.shared.open(url)
                }
            }
            Button("Report an Issue") {
                if let url = URL(string: "https://github.com/thenextdeveloper/DxxpCode-Terminal/issues") {
                    NSWorkspace.shared.open(url)
                }
            }
        }
    }

    private func respondIfApproval(_ allow: Bool) {
        session?.respondApproval(allow: allow)
    }
}

/// Simple NSOpenPanel wrapper — directory-only picker.
@MainActor
enum OpenProjectPanel {
    static func open(_ completion: @escaping (URL) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Open Project"
        panel.message = "Choose a project folder for the agent to work in"
        if panel.runModal() == .OK, let url = panel.url {
            completion(url)
        }
    }
}
