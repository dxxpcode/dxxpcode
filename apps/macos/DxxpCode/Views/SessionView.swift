import SwiftUI

/// The detail pane: transcript on top, composer pinned to the bottom.
struct SessionView: View {
    let session: SessionModel
    @Environment(AppModel.self) private var model
    @State private var task = ""

    var body: some View {
        VStack(spacing: 0) {
            TranscriptView(session: session)
            Divider()
            statusBar
            ComposerView(session: session, task: $task) {
                let text = task
                task = ""
                Task {
                    await session.start(task: text,
                                        effort: model.effort,
                                        model: model.model,
                                        autoApprove: model.autoApprove)
                }
            }
        }
        .focusedValue(\.session, session)
    }

    @ViewBuilder
    private var statusBar: some View {
        if session.running || session.statusLine != nil {
            HStack(spacing: 6) {
                if session.running { ProgressView().controlSize(.small) }
                Text(session.statusLine ?? "Working…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
                if session.running {
                    Button("Cancel") { session.cancel() }
                        .controlSize(.small)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.bar)
        }
    }
}
