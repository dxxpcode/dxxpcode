import SwiftUI

/// First-run surface: drag-a-folder target + open button.
struct EmptyStateView: View {
    @Environment(AppModel.self) private var model
    @State private var targeted = false

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "folder.badge.plus")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text("Open a project to start")
                .font(.title2)
            Text("Drop a folder here, or")
                .foregroundStyle(.secondary)
            Button("Open Project…") {
                OpenProjectPanel.open { url in
                    Task { await model.openProject(at: url) }
                }
            }
            .keyboardShortcut("o")
            if let err = model.lastBridgeError {
                Label(err, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onDrop(of: [.fileURL], isTargeted: $targeted) { providers in
            let appModel = model
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    if let url {
                        Task { await appModel.openProject(at: url) }
                    }
                }
            }
            return true
        }
        .background(targeted ? Color.accentColor.opacity(0.06) : .clear)
    }
}
