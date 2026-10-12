import SwiftUI

// Screen 4 — start a task on the desktop: pick a known project root, write the
// prompt, optionally plan-only. Runs on the Mac; the phone watches via SSE.
struct NewTaskView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) var dismiss
    @State private var projects: [DxxpAPI.Project] = []
    @State private var cwd = ""
    @State private var prompt = ""
    @State private var planOnly = false
    @State private var autoApprove = false
    @State private var busy = false
    @State private var error: String?
    @State private var createdId: String?

    var body: some View {
        Form {
            Section {
                Picker("Project", selection: $cwd) {
                    ForEach(projects) { p in
                        Text(p.name).tag(p.root)
                    }
                }
                .pickerStyle(.menu)
                Text(projects.first(where: { $0.root == cwd })?.root ?? cwd)
                    .font(.dxMonoSmall)
                    .foregroundStyle(Color.dxFaint)
            } header: { Text("PROJECT").font(.dxGroupLabel).tracking(1.1).foregroundStyle(Color.dxFaint.opacity(0.75)) }

            Section {
                TextField("What should the agent do?", text: $prompt, axis: .vertical)
                    .lineLimit(4...10)
            } header: { Text("PROMPT").font(.dxGroupLabel).tracking(1.1).foregroundStyle(Color.dxFaint.opacity(0.75)) }

            Section {
                Toggle("Plan only", isOn: $planOnly)
                Toggle("Auto-approve commands", isOn: $autoApprove)
            } header: { Text("OPTIONS").font(.dxGroupLabel).tracking(1.1).foregroundStyle(Color.dxFaint.opacity(0.75)) }

            if let error {
                Section { Text(error).foregroundStyle(Color.dxRed).font(.caption) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.dxBg)
        .navigationTitle("New task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(busy ? "Starting…" : "Start") { start() }
                    .disabled(busy || prompt.trimmingCharacters(in: .whitespaces).isEmpty || cwd.isEmpty)
                    .font(.body.weight(.semibold))
            }
        }
        .task { await load() }
        .navigationDestination(item: $createdId) { id in
            TaskDetailView(taskId: id)
        }
    }

    private func load() async {
        guard let api = app.api else { return }
        projects = (try? await api.projects()) ?? []
        if cwd.isEmpty { cwd = projects.first?.root ?? "" }
    }

    private func start() {
        guard let api = app.api else { return }
        busy = true
        error = nil
        Task {
            do {
                let id = try await api.createTask(.init(
                    prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                    cwd: cwd,
                    planOnly: planOnly ? true : nil,
                    autoApprove: autoApprove ? true : nil
                ))
                if id.isEmpty { dismiss() } else { createdId = id }
            } catch {
                self.error = error.localizedDescription
                busy = false
            }
        }
    }
}

extension String: @retroactive Identifiable {
    public var id: String { self }
}
