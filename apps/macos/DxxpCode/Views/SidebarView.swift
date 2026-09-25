import SwiftUI

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @State private var filter = ""

    /// Draft session shows as a synthetic "new" tag so List selection stays
    /// a single String value; nil ⇄ "new" mapping keeps sessions unambiguous.
    private var selection: Binding<String?> {
        Binding(
            get: { model.selectedSessionId ?? "new" },
            set: { model.selectedSessionId = $0 == "new" ? nil : $0 }
        )
    }

    var body: some View {
        List(selection: selection) {
            Section("Projects") {
                ForEach(filteredProjects) { project in
                    ProjectRow(project: project, isSelected: project.id == model.selectedProjectId)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            model.selectedProjectId = project.id
                        }
                }
            }
            if let project = model.selectedProject {
                Section("Sessions — \(project.name)") {
                    if let err = project.bridgeError {
                        Label(err, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                    Label {
                        Text("New Session")
                            .foregroundStyle(Color.accentColor)
                    } icon: {
                        Image(systemName: "plus.circle.fill")
                            .foregroundStyle(Color.accentColor)
                    }
                    .font(.callout.weight(.medium))
                    .tag("new")
                    ForEach(filteredSessions(in: project)) { summary in
                        SessionRow(summary: summary)
                            .tag(summary.id)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                TextField("Filter", text: $filter)
                    .textFieldStyle(.plain)
                    .font(.callout)
                if !filter.isEmpty {
                    Button {
                        filter = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.bar)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    OpenProjectPanel.open { url in
                        Task { await model.openProject(at: url) }
                    }
                } label: {
                    Label("Open Project", systemImage: "folder.badge.plus")
                }
                .help("Open a project folder")
            }
        }
        .navigationTitle("DxxpCode")
    }

    private var filteredProjects: [ProjectModel] {
        guard !filter.isEmpty else { return model.projects }
        return model.projects.filter { $0.name.localizedCaseInsensitiveContains(filter) }
    }

    private func filteredSessions(in project: ProjectModel) -> [SessionSummary] {
        guard !filter.isEmpty else { return project.sessions }
        return project.sessions.filter {
            $0.task.localizedCaseInsensitiveContains(filter) || $0.id.localizedCaseInsensitiveContains(filter)
        }
    }
}

private struct ProjectRow: View {
    let project: ProjectModel
    let isSelected: Bool

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 1) {
                Text(project.name)
                    .font(.callout.weight(isSelected ? .semibold : .regular))
                Text(project.root)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        } icon: {
            Image(systemName: isSelected ? "folder.fill" : "folder")
                .foregroundStyle(isSelected ? Color.accentColor : .secondary)
        }
        .padding(.vertical, 2)
    }
}

private struct SessionRow: View {
    let summary: SessionSummary

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: statusIcon)
                .font(.callout)
                .foregroundStyle(statusColor)
                .frame(width: 16)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(summary.task.isEmpty ? "Untitled session" : summary.task)
                    .font(.callout)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    if let result = summary.result {
                        Text(result)
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(statusColor.opacity(0.15), in: Capsule())
                            .foregroundStyle(statusColor)
                    }
                    Text(relativeDate(summary.updatedAt))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 3)
    }

    private var statusIcon: String {
        switch summary.result {
        case "completed": return "checkmark.circle.fill"
        case "denied", "cancelled": return "hand.raised.fill"
        case "error", "max_iterations": return "xmark.circle.fill"
        case nil: return "bubble.left"
        default: return "circle"
        }
    }

    private var statusColor: Color {
        switch summary.result {
        case "completed": return .green
        case "denied", "cancelled": return .orange
        case "error", "max_iterations": return .red
        default: return .secondary
        }
    }

    private func relativeDate(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        guard let date = f.date(from: iso) else { return iso }
        let rel = RelativeDateTimeFormatter()
        rel.unitsStyle = .abbreviated
        return rel.localizedString(for: date, relativeTo: Date())
    }
}
