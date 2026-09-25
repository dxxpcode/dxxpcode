import SwiftUI

/// Virtualized streaming transcript in a centered, readable column.
/// Rows render per TranscriptItem kind; text rows host MarkdownText
/// (which handles inline md + fenced code).
struct TranscriptView: View {
    let session: SessionModel

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                HStack {
                    Spacer(minLength: 0)
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(session.items) { item in
                            TranscriptRow(item: item, session: session)
                                .id(item.id)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id("transcript-tail")
                    }
                    .frame(maxWidth: 720)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 20)
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
                .lineSpacing(3)
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
            NoticeRow(icon: "hand.raised.slash", text: "\(tool): \(reason)", tint: .red)

        case .compacted(_, let before, let after):
            NoticeRow(icon: "arrow.down.right.and.arrow.up.left",
                      text: "Context compacted: \(before) → \(after) blocks",
                      tint: .secondary)

        case .done(_, let result):
            DoneRow(result: result)

        case .note(_, let message):
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }
}

/// Small centered system message — denied notices, compaction notes.
private struct NoticeRow: View {
    let icon: String
    let text: String
    let tint: Color

    var body: some View {
        Label(text, systemImage: icon)
            .font(.caption)
            .foregroundStyle(tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(tint.opacity(0.10), in: Capsule())
            .frame(maxWidth: .infinity, alignment: .center)
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
                HStack(spacing: 10) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 5)
                            .fill(tint.opacity(0.14))
                        Image(systemName: iconName)
                            .font(.caption)
                            .foregroundStyle(tint)
                    }
                    .frame(width: 22, height: 22)

                    VStack(alignment: .leading, spacing: 1) {
                        Text(tool)
                            .font(.callout.monospaced().weight(.semibold))
                        if !detail.isEmpty {
                            Text(detail)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    Spacer(minLength: 8)
                    if result == nil {
                        ProgressView().controlSize(.small)
                    } else if result?.isError == true {
                        Image(systemName: "exclamationmark.circle.fill")
                            .foregroundStyle(.red)
                    } else {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded, let result {
                Divider().padding(.horizontal, 10)
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(result.content.isEmpty ? "(no output)" : result.content)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .foregroundStyle(result.isError == true ? .red : .primary)
                        .padding(10)
                }
            }
        }
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.primary.opacity(0.06))
        }
        .accessibilityLabel("\(tool) \(detail)")
    }

    private var tint: Color {
        if result?.isError == true { return .red }
        switch tool {
        case "run_command": return .accentColor
        case "read_file", "search_files", "list_files": return .teal
        case "write_file", "edit_file": return .orange
        case "delete_file": return .red
        case "git_status", "git_diff", "git_log": return .purple
        case "todo_write": return .green
        case "propose_plan": return .accentColor
        default: return .secondary
        }
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
        HStack(alignment: .top, spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 6)
                    .fill(color.opacity(0.14))
                Image(systemName: iconName)
                    .font(.callout)
                    .foregroundStyle(color)
            }
            .frame(width: 26, height: 26)
            VStack(alignment: .leading, spacing: 3) {
                Text(result.status.capitalized)
                    .font(.callout.weight(.semibold))
                if !result.summary.isEmpty {
                    Text(result.summary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                if let stat = result.diffStat, !stat.isEmpty {
                    Text(stat)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(color.opacity(0.15))
        }
    }

    private var iconName: String {
        switch result.status {
        case "completed": return "checkmark"
        case "cancelled", "denied": return "xmark"
        default: return "exclamationmark"
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
