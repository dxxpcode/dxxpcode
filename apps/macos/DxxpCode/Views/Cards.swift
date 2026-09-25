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
        VStack(alignment: .leading, spacing: 12) {
            CardHeader(icon: "list.number", title: "Proposed Plan", tint: .accentColor)

            Text(plan.summary)
                .font(.callout)

            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(plan.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .top, spacing: 8) {
                        ZStack {
                            Circle().fill(Color.accentColor.opacity(0.12))
                            Text("\(index + 1)")
                                .font(.caption.weight(.semibold).monospaced())
                                .foregroundStyle(Color.accentColor)
                        }
                        .frame(width: 18, height: 18)
                        .padding(.top, 1)
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
                    Button("Reject ⌘.", role: .cancel, action: onReject)
                        .keyboardShortcut(".", modifiers: .command)
                }
                .controlSize(.regular)
            } else if let response {
                ResponseBadge(text: {
                    switch response {
                    case .approved: return "Approved"
                    case .rejected: return "Rejected"
                    case .autoApproved: return "Auto-approved"
                    }
                }(), color: {
                    switch response {
                    case .approved: return .green
                    case .rejected: return .red
                    case .autoApproved: return .secondary
                    }
                }())
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.accentColor.opacity(awaiting ? 0.5 : 0.15))
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Proposed plan")
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
        VStack(alignment: .leading, spacing: 10) {
            CardHeader(icon: "hand.raised", title: "Approval Required", tint: .orange)

            VStack(alignment: .leading, spacing: 6) {
                Text(request.tool)
                    .font(.callout.monospaced().weight(.semibold))
                Text(preview)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
                if let reason = request.reason, !reason.isEmpty {
                    Label(reason, systemImage: "info.circle")
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
                    Button("Deny", role: .destructive, action: onDeny)
                        .keyboardShortcut(.escape, modifiers: [])
                }
                .controlSize(.regular)
            } else if let response {
                ResponseBadge(text: {
                    switch response {
                    case .allowed: return "Allowed"
                    case .alwaysAllowed: return "Always allowed"
                    case .denied: return "Denied"
                    case .autoAllowed: return "Allowed earlier"
                    }
                }(), color: {
                    switch response {
                    case .allowed, .alwaysAllowed: return .green
                    case .denied: return .red
                    case .autoAllowed: return .secondary
                    }
                }())
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
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
}

/// Icon-in-tinted-square + semibold title used at the top of transcript cards.
private struct CardHeader: View {
    let icon: String
    let title: String
    let tint: Color

    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 6)
                    .fill(tint)
                Image(systemName: icon)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 22, height: 22)
            Text(title)
                .font(.callout.weight(.semibold))
        }
    }
}

/// Capsule outcome badge shared by both cards.
private struct ResponseBadge: View {
    let text: String
    let color: Color

    var body: some View {
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
