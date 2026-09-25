import SwiftUI

/// Virtualized streaming transcript. Rows render per TranscriptItem kind;
/// text rows host MarkdownText (which handles inline md + fenced code).
struct TranscriptView: View {
    let session: SessionModel

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(session.items) { item in
                        TranscriptRow(item: item, session: session)
                            .id(item.id)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("transcript-tail")
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: session.items.count) { _, _ in
                withAnimation(.easeOut(duration: 0.15)) {
                    proxy.scrollTo("transcript-tail", anchor: .bottom)
                }
            }
            .onChange(of: session.items.last?.id) { _, _ in
                proxy.scrollTo("transcript-tail", anchor: .bottom)
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
    }
}

private struct TranscriptRow: View {
    let item: TranscriptItem
    let session: SessionModel

    var body: some View {
        switch item {
        case .text(_, let text):
            MarkdownText(text)
                .scaleEffect(x: TextScale.shared.factor, y: TextScale.shared.factor,
                             anchor: .topLeading)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .tool(_, let tool, let detail, let result):
            ToolRow(tool: tool, detail: detail, result: result)

        case .plan(_, let plan, let requestId, let response):
            PlanCardView(plan: plan,
                         awaiting: requestId != nil && response == nil,
                         response: response,
                         onApprove: { session.approvePlan(true) },
                         onReject: { session.approvePlan(false) })

        case .approval(_, let request, let requestId, let response):
            ApprovalCardView(request: request,
                             awaiting: requestId != nil && response == nil,
                             response: response,
                             onAllow: { session.respondApproval(allow: true) },
                             onAlways: { session.respondApproval(allow: true, always: true) },
                             onDeny: { session.respondApproval(allow: false) })

        case .denied(_, let tool, let reason):
            Label("\(tool): \(reason)", systemImage: "hand.raised.slash")
                .font(.callout)
                .foregroundStyle(.red)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))

        case .compacted(_, let before, let after):
            Label("Context compacted: \(before) → \(after) blocks",
                  systemImage: "arrow.down.right.and.arrow.up.left")
                .font(.caption)
                .foregroundStyle(.secondary)

        case .done(_, let result):
            DoneRow(result: result)

        case .note(_, let message):
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct ToolRow: View {
    let tool: String
    let detail: String
    let result: ToolResult?
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                if result != nil { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: iconName)
                        .frame(width: 16)
                        .foregroundStyle(.secondary)
                    Text(tool)
                        .font(.callout.monospaced().weight(.medium))
                    Text(detail)
                        .font(.callout.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    if result == nil {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded, let result {
                Text(result.content.isEmpty ? "(no output)" : result.content)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .foregroundStyle(result.isError == true ? .red : .primary)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.04))
            }
        }
        .padding(8)
        .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityLabel("\(tool) \(detail)")
    }

    private var iconName: String {
        switch tool {
        case "run_command": return "terminal"
        case "read_file": return "doc.text"
        case "write_file", "edit_file": return "pencil"
        case "delete_file": return "trash"
        case "search_files": return "magnifyingglass"
        case "list_files": return "folder"
        case "git_status", "git_diff", "git_log": return "arrow.triangle.branch"
        case "todo_write": return "checklist"
        case "propose_plan": return "list.number"
        default: return "wrench"
        }
    }
}

private struct DoneRow: View {
    let result: RunResult

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: iconName)
                .foregroundStyle(color)
            VStack(alignment: .leading, spacing: 2) {
                Text(result.status.capitalized)
                    .font(.callout.weight(.semibold))
                if !result.summary.isEmpty {
                    Text(result.summary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                if let stat = result.diffStat, !stat.isEmpty {
                    Text(stat)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    private var iconName: String {
        switch result.status {
        case "completed": return "checkmark.circle.fill"
        case "cancelled", "denied": return "xmark.circle.fill"
        default: return "exclamationmark.circle.fill"
        }
    }

    private var color: Color {
        switch result.status {
        case "completed": return .green
        case "cancelled", "denied": return .orange
        default: return .red
        }
    }
}
