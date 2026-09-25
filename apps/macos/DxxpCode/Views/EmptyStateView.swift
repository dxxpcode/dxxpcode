import SwiftUI

/// First-run surface: drag-a-folder target + open button.
struct EmptyStateView: View {
    @Environment(AppModel.self) private var model
    @State private var targeted = false

    var body: some View {
        VStack(spacing: 20) {
            ZStack {
                Circle()
                    .fill(Color.accentColor.opacity(targeted ? 0.20 : 0.10))
                Image(systemName: "folder.badge.plus")
                    .font(.system(size: 34))
                    .foregroundStyle(Color.accentColor)
            }
            .frame(width: 84, height: 84)
            .animation(.easeInOut(duration: 0.15), value: targeted)

            VStack(spacing: 6) {
                Text("Open a project to start")
                    .font(.title2.weight(.semibold))
                Text("Drop a project folder anywhere in this window,\nor pick one with the button below.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Button("Open Project…") {
                OpenProjectPanel.open { url in
                    Task { await model.openProject(at: url) }
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .keyboardShortcut("o")

            if let err = model.lastBridgeError {
                Label(err, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .padding(.top, 4)
            }
        }
        .padding(40)
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
        .background {
            if targeted {
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [8, 6]))
                    .foregroundStyle(Color.accentColor.opacity(0.6))
                    .padding(16)
            }
        }
    }
}
