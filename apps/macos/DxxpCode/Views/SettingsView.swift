import SwiftUI

/// Minimal settings (milestone-1 scope): run defaults + agentd info.
/// Provider keys land in milestone 3 (Keychain + secrets.set).
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var agentdPath: String = ""

    var body: some View {
        @Bindable var model = model
        Form {
            Section("Run Defaults") {
                Picker("Reasoning effort", selection: $model.effort) {
                    ForEach(reasonEfforts, id: \.self) { Text($0).tag($0) }
                }
                Toggle("Auto-approve approval-tier actions (--yes)", isOn: $model.autoApprove)
            }
            Section("Runtime") {
                LabeledContent("agentd") {
                    Text(agentdPath.isEmpty ? "resolving…" : agentdPath)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .padding()
        .task {
            if let launch = try? AgentdLocator.resolve() {
                agentdPath = launch.executable.path + (launch.arguments.isEmpty ? "" : " " + launch.arguments.joined(separator: " "))
            }
        }
    }
}
