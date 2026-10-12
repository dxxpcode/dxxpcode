import SwiftUI

// Screen 2 — running + recent tasks, palette-style thin list with group labels.
struct TaskListView: View {
    @EnvironmentObject var app: AppModel
    @State private var tasks: [DxxpAPI.TaskSummary] = []
    @State private var search = ""
    @State private var loading = true
    @State private var error: String?


    private var visible: [DxxpAPI.TaskSummary] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return tasks }
        return tasks.filter {
            $0.title.lowercased().contains(q) || $0.cwd.lowercased().contains(q)
        }
    }

    var body: some View {
        Group {
            if loading && tasks.isEmpty {
                ProgressView().tint(Color.dxFaint)
            } else if let error, tasks.isEmpty {
                VStack(spacing: 10) {
                    Text("Can't reach the desktop").font(.callout.weight(.medium))
                    Text(error).font(.caption).foregroundStyle(Color.dxFaint).multilineTextAlignment(.center)
                    Text("Is iPhone companion on? Same Wi-Fi?").font(.caption2).foregroundStyle(Color.dxFaint)
                }.padding(32)
            } else {
                List {
                    Section {
                        ForEach(visible) { t in
                            NavigationLink(value: t.id) {
                                TaskRow(task: t)
                            }
                            .listRowBackground(Color.dxSurface)
                            .listRowSeparatorTint(Color.dxBorder)
                        }
                    } header: {
                        Text("TASKS").font(.dxGroupLabel).tracking(1.1)
                            .foregroundStyle(Color.dxFaint.opacity(0.75))
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .refreshable { await load() }
            }
        }
        .background(Color.dxBg)
        .navigationTitle("DxxpCode")
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search tasks")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                NavigationLink { SettingsView() } label: { Image(systemName: "gearshape") }
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink { NewTaskView() } label: { Image(systemName: "plus") }
            }
        }
        .navigationDestination(for: String.self) { id in
            TaskDetailView(taskId: id)
        }
        .task { await load() }
        .task {
            if let id = app.deepLinkTask {
                app.deepLinkTask = nil
                try? await Task.sleep(for: .milliseconds(300))
                app.navPath.append(id)
            }
        }
        .onReceive(Timer.publish(every: 4, on: .main, in: .common).autoconnect()) { _ in
            Task { await load() }
        }
    }

    private func load() async {
        guard let api = app.api else { return }
        do {
            tasks = try await api.tasks().reversed()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}

struct TaskRow: View {
    let task: DxxpAPI.TaskSummary

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(dotColor)
                .frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title.isEmpty ? "Untitled task" : task.title)
                    .font(.callout)
                    .foregroundStyle(Color.dxText)
                    .lineLimit(1)
                Text(task.cwd)
                    .font(.dxMonoSmall)
                    .foregroundStyle(Color.dxFaint)
                    .lineLimit(1)
            }
            Spacer()
            Text(task.status)
                .font(.caption2)
                .foregroundStyle(Color.dxFaint)
        }
        .padding(.vertical, 2)
    }

    private var dotColor: Color {
        switch task.status {
        case "running", "queued": return Color(UIColor.dx(light: 0x2563eb, dark: 0x60a5fa))
        case "approval": return Color(UIColor.dx(light: 0xd97706, dark: 0xfbbf24))
        case "done", "completed": return Color(UIColor.dx(light: 0x16a34a, dark: 0x4ade80))
        case "failed", "error": return .dxRed
        default: return .dxFaint
        }
    }
}
