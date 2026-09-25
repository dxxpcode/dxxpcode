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
                    Label("New Session", systemImage: "plus.bubble")
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
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Filter", text: $filter)
                    .textFieldStyle(.plain)
            }
            .padding(8)
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
            Text(project.name)
                .fontWeight(isSelected ? .semibold : .regular)
        } icon: {
            Image(systemName: "folder")
                .foregroundStyle(isSelected ? Color.accentColor : .secondary)
        }
        .padding(.vertical, 2)
    }
}

private struct SessionRow: View {
    let summary: SessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(summary.task.isEmpty ? "Untitled session" : summary.task)
                .lineLimit(2)
            HStack(spacing: 4) {
                if let result = summary.result {
                    Text(result)
                        .font(.caption2)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(statusColor(result).opacity(0.15), in: Capsule())
                        .foregroundStyle(statusColor(result))
                }
                Text(relativeDate(summary.updatedAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private func statusColor(_ result: String) -> Color {
        switch result {
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
