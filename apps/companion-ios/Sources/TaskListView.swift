import SwiftUI

// Screen 2 — running + recent tasks as palette-style thin rows: sesspal
// density, small-caps group labels (RUNNING / RECENT), status tokens.
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

    private var running: [DxxpAPI.TaskSummary] {
        visible.filter { ["running", "queued", "approval"].contains($0.status) }
    }
    private var recent: [DxxpAPI.TaskSummary] {
        visible.filter { !["running", "queued", "approval"].contains($0.status) }
    }

    var body: some View {
        Group {
            if loading && tasks.isEmpty {
                ProgressView().tint(Color.dxFaint)
            } else if let error, tasks.isEmpty {
                unreachableView(error)
            } else if visible.isEmpty {
                emptyView
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if !running.isEmpty {
                            DXGroupLabel("Running")
                            ForEach(running) { t in TaskRow(task: t) }
                        }
                        if !recent.isEmpty {
                            DXGroupLabel(running.isEmpty ? "Tasks" : "Recent")
                            ForEach(recent) { t in TaskRow(task: t) }
                        }
                    }
                    .padding(.bottom, 24)
                }
                .refreshable { await load() }
            }
        }
        .background(Color.dxBg)
        .navigationTitle("DxxpCode")
        .toolbar {
            ToolbarItem(placement: .principal) {
                XXMark()
                    .fill(Color.dxText)
                    .frame(width: 16, height: 16)
            }
            ToolbarItem(placement: .topBarLeading) {
                NavigationLink { SettingsView() } label: {
                    Image(systemName: "gearshape").fontWeight(.light)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink { NewTaskView() } label: {
                    Image(systemName: "plus").fontWeight(.light)
                }
            }
        }
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search tasks")
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

    private var emptyView: some View {
        VStack(spacing: 14) {
            XXMark()
                .fill(Color.dxFaint.opacity(0.25))
                .frame(width: 64, height: 64)
            Text(search.isEmpty ? "No tasks yet" : "No matches")
                .font(.callout.weight(.medium))
                .foregroundStyle(Color.dxFaint)
            if search.isEmpty {
                NavigationLink { NewTaskView() } label: {
                    Text("Start a task")
                }
                .buttonStyle(DXPrimaryButton())
                .frame(maxWidth: 220)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func unreachableView(_ msg: String) -> some View {
        VStack(spacing: 10) {
            Text("Can't reach the desktop").font(.callout.weight(.medium))
            Text(msg).font(.caption).foregroundStyle(Color.dxFaint).multilineTextAlignment(.center)
            Text("Is iPhone companion on? Same Wi-Fi?").font(.caption2).foregroundStyle(Color.dxFaint)
        }.padding(32)
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
        NavigationLink(value: task.id) {
            HStack(spacing: 10) {
                Circle()
                    .fill(dotColor)
                    .frame(width: 6, height: 6)
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
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(statusColor)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Color.dxSurface2)
                    .clipShape(Capsule())
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Color.dxFaint.opacity(0.6))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var isActive: Bool { ["running", "queued", "approval"].contains(task.status) }

    private var dotColor: Color {
        switch task.status {
        case "running", "queued": return Color(UIColor.dx(light: 0x2563eb, dark: 0x60a5fa))
        case "approval": return Color(UIColor.dx(light: 0xd97706, dark: 0xfbbf24))
        case "done", "completed": return Color(UIColor.dx(light: 0x16a34a, dark: 0x4ade80))
        case "failed", "error", "incomplete": return .dxRed
        default: return .dxFaint
        }
    }

    private var statusColor: Color {
        isActive ? dotColor : Color.dxFaint
    }
}
