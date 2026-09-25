import SwiftUI

/// The detail pane: transcript on top, composer pinned to the bottom.
struct SessionView: View {
    let session: SessionModel
    @Environment(AppModel.self) private var model
    @State private var task = ""

    var body: some View {
        VStack(spacing: 0) {
            TranscriptView(session: session)
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
        .animation(.snappy(duration: 0.2), value: session.running)
    }

    @ViewBuilder
    private var statusBar: some View {
        if session.running || session.statusLine != nil {
            HStack(spacing: 8) {
                if session.running {
                    ProgressView().controlSize(.small)
                }
                Text(session.statusLine ?? "Working…")
                    .font(.callout)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
                if session.running {
                    Button("Cancel") { session.cancel() }
                        .controlSize(.small)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(.bar)
            .overlay(alignment: .bottom) {
                Rectangle().fill(.separator).frame(height: 1)
            }
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
    }
}
