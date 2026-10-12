import SwiftUI

// Screen 4 — start a task on the desktop: card layout matching the pair card,
// sticky bottom CTA. Runs on the Mac; the phone watches via SSE.
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

    private var canStart: Bool {
        !busy && !prompt.trimmingCharacters(in: .whitespaces).isEmpty && !cwd.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 0) {
                        DXGroupLabel("Project")
                        VStack(alignment: .leading, spacing: 6) {
                            Picker("Project", selection: $cwd) {
                                ForEach(projects) { p in
                                    Text(p.name).tag(p.root)
                                }
                            }
                            .pickerStyle(.menu)
                            .tint(Color.dxText)
                            Text(cwd.isEmpty ? "no projects on this desktop yet" : cwd)
                                .font(.dxMonoSmall)
                                .foregroundStyle(Color.dxFaint)
                                .lineLimit(1)
                        }
                        .padding(12)
                        .dxCard()
                        .padding(.horizontal, 16)
                    }

                    VStack(alignment: .leading, spacing: 0) {
                        DXGroupLabel("Prompt")
                        TextField("What should the agent do?", text: $prompt, axis: .vertical)
                            .font(.callout)
                            .lineLimit(4...10)
                            .padding(12)
                            .dxCard()
                            .padding(.horizontal, 16)
                    }

                    VStack(alignment: .leading, spacing: 0) {
                        DXGroupLabel("Options")
                        VStack(spacing: 0) {
                            optionRow("Plan only", "Agent stops after writing the plan", $planOnly)
                            Divider().overlay(Color.dxBorder.opacity(0.5)).padding(.leading, 12)
                            optionRow("Auto-approve commands", "Skip per-command approvals", $autoApprove)
                        }
                        .dxCard()
                        .padding(.horizontal, 16)
                    }

                    if let error {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(Color.dxRed)
                            .padding(.horizontal, 20)
                    }
                }
                .padding(.top, 8)
                .padding(.bottom, 90)
            }

            Button { start() } label: {
                Text(busy ? "Starting…" : "Start task")
            }
            .buttonStyle(DXPrimaryButton())
            .disabled(!canStart)
            .opacity(canStart ? 1 : 0.4)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .background(
                LinearGradient(colors: [Color.dxBg.opacity(0), Color.dxBg],
                               startPoint: .top, endPoint: .bottom)
                    .frame(height: 70)
                    .allowsHitTesting(false)
                    .ignoresSafeArea(),
                alignment: .bottom
            )
        }
        .background(Color.dxBg)
        .navigationTitle("New task")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .navigationDestination(item: $createdId) { id in
            TaskDetailView(taskId: id)
        }
    }

    private func optionRow(_ title: String, _ subtitle: String, _ on: Binding<Bool>) -> some View {
        Toggle(isOn: on) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.callout)
                Text(subtitle).font(.caption2).foregroundStyle(Color.dxFaint)
            }
        }
        .tint(Color.dxText)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
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
        DXHaptics.tap()
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
