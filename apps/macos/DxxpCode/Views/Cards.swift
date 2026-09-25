import SwiftUI

/// The plan phase, rendered as a card: summary + numbered steps, with
/// Approve / Reject while it awaits `plan.respond`.
struct PlanCardView: View {
    let plan: ProposedPlan
    let awaiting: Bool
    let response: TranscriptItem.PlanResponse?
    let onApprove: () -> Void
    let onReject: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Proposed Plan", systemImage: "list.number")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.secondary)

            Text(plan.summary)
                .font(.callout)

            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(plan.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .top, spacing: 8) {
                        Text("\(index + 1).")
                            .font(.callout.monospaced())
                            .foregroundStyle(.secondary)
                            .frame(width: 20, alignment: .trailing)
                        Text(step)
                            .font(.callout)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }

            if awaiting {
                HStack(spacing: 10) {
                    Button("Approve ⌘⏎", action: onApprove)
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.return, modifiers: .command)
                    Button("Reject ⌘.", action: onReject)
                        .keyboardShortcut(".", modifiers: .command)
                }
            } else if let response {
                responseBadge(response)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.accentColor.opacity(awaiting ? 0.5 : 0.15))
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Proposed plan")
    }

    @ViewBuilder
    private func responseBadge(_ response: TranscriptItem.PlanResponse) -> some View {
        let (text, color): (String, Color) = switch response {
        case .approved: ("Approved", .green)
        case .rejected: ("Rejected", .red)
        case .autoApproved: ("Auto-approved", .secondary)
        }
        Text(text)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}

/// A gated action awaiting `approval.respond`: the tool call, its reason,
/// and Allow once / Always Allow / Deny.
struct ApprovalCardView: View {
    let request: ApprovalRequest
    let awaiting: Bool
    let response: TranscriptItem.ApprovalResponse?
    let onAllow: () -> Void
    let onAlways: () -> Void
    let onDeny: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Approval Required", systemImage: "hand.raised")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.orange)

            VStack(alignment: .leading, spacing: 4) {
                Text(request.tool)
                    .font(.callout.monospaced().weight(.medium))
                Text(preview)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
                if let reason = request.reason, !reason.isEmpty {
                    Text(reason)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                if let d = request.decision.reason.nilIfEmpty {
                    Text(d)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if awaiting {
                HStack(spacing: 10) {
                    Button("Allow Once ⌘⏎", action: onAllow)
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.return, modifiers: .command)
                    Button("Always Allow ⌥⌘A", action: onAlways)
                        .keyboardShortcut("a", modifiers: [.command, .option])
                    Button("Deny", action: onDeny)
                        .keyboardShortcut(.escape, modifiers: [])
                }
            } else if let response {
                responseBadge(response)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.orange.opacity(awaiting ? 0.5 : 0.15))
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Approval required")
    }

    private var preview: String {
        if request.tool == "run_command",
           let cmd = request.input["command"]?.stringValue {
            return cmd
        }
        if let path = request.input["path"]?.stringValue {
            return path
        }
        return request.input.compactDescription
    }

    @ViewBuilder
    private func responseBadge(_ response: TranscriptItem.ApprovalResponse) -> some View {
        let (text, color): (String, Color) = switch response {
        case .allowed: ("Allowed", .green)
        case .alwaysAllowed: ("Always allowed", .green)
        case .denied: ("Denied", .red)
        case .autoAllowed: ("Allowed earlier", .secondary)
        }
        Text(text)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
