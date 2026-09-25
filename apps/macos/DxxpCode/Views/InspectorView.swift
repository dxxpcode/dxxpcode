import SwiftUI

/// Right-hand inspector: changed files with diffs, todo checklist,
/// checkpoints, and run usage. Mirrors plan §4 "changed-files inspector".
struct InspectorView: View {
    let session: SessionModel
    @State private var undoMessage: String?

    var body: some View {
        List {
            Section("Changed Files") {
                if session.changedFiles.isEmpty {
                    Text("No changes yet")
                        .foregroundStyle(.secondary)
                        .font(.callout)
                }
                ForEach(session.changedFiles) { file in
                    ChangedFileRow(path: file.path, diff: file.diff, root: session.projectRoot)
                }
            }

            if !session.todos.isEmpty {
                Section("Checklist") {
                    ForEach(session.todos, id: \.id) { item in
                        Label {
                            Text(item.status == "in_progress" && item.activeForm != nil
                                 ? item.activeForm! : item.content)
                                .font(.callout)
                                .strikethrough(item.status == "completed")
                        } icon: {
                            Image(systemName: icon(for: item.status))
                                .foregroundStyle(color(for: item.status))
                        }
                    }
                }
            }

            if !session.checkpoints.isEmpty {
                Section("Checkpoints") {
                    ForEach(session.checkpoints) { cp in
                        HStack {
                            Text("#\(cp.seq)")
                                .font(.callout.monospaced())
                            Text("\(cp.paths.count) file\(cp.paths.count == 1 ? "" : "s")")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Spacer()
                        }
                    }
                    Button("Restore Latest") {
                        Task { undoMessage = await session.undoToCheckpoint() }
                    }
                    .disabled(session.checkpoints.isEmpty)
                    if let undoMessage {
                        Text(undoMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("Run") {
                if let usage = session.usage {
                    LabeledContent("Input tokens", value: "\(usage.inputTokens)")
                    LabeledContent("Output tokens", value: "\(usage.outputTokens)")
                }
                if session.autoAllowCount > 0 {
                    LabeledContent("Auto-allowed", value: "\(session.autoAllowCount)")
                }
                if let result = session.result {
                    LabeledContent("Status", value: result.status)
                    LabeledContent("Tool calls", value: "\(result.toolCalls)")
                    if !result.commands.isEmpty {
                        LabeledContent("Commands", value: "\(result.commands.count)")
                    }
                }
            }
        }
        .listStyle(.sidebar)
    }

    private func icon(for status: String) -> String {
        switch status {
        case "completed": return "checkmark.circle.fill"
        case "in_progress": return "circle.dotted.circle"
        default: return "circle"
        }
    }

    private func color(for status: String) -> Color {
        switch status {
        case "completed": return .green
        case "in_progress": return .accentColor
        default: return .secondary
        }
    }
}

private struct ChangedFileRow: View {
    let path: String
    let diff: String?
    let root: String
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                if diff != nil { expanded.toggle() }
            } label: {
                HStack {
                    Image(systemName: "doc.text")
                        .foregroundStyle(.secondary)
                    Text(path)
                        .font(.callout.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    if diff != nil {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button("Open in Editor") {
                    NSWorkspace.shared.open(URL(fileURLWithPath: root).appendingPathComponent(path))
                }
                Button("Reveal in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting(
                        [URL(fileURLWithPath: root).appendingPathComponent(path)])
                }
            }
            if expanded, let diff {
                DiffText(diff)
                    .padding(.top, 4)
            }
        }
    }
}
