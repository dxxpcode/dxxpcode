import SwiftUI

/// Effort picker bound to AppModel.effort (minimal→max).
struct EffortPicker: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Picker("Effort", selection: $model.effort) {
            ForEach(reasonEfforts, id: \.self) { effort in
                Text(effort).tag(effort)
            }
        }
        .pickerStyle(.menu)
        .fixedSize()
    }
}

/// Approval mode toggle: on = run.start autoApprove (CLI --yes equivalent).
struct AutoApproveToggle: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Toggle(isOn: $model.autoApprove) {
            Image(systemName: model.autoApprove ? "bolt.shield" : "hand.raised")
        }
        .toggleStyle(.button)
        .help(model.autoApprove
              ? "Auto-approve is ON — approval-tier actions run without prompting"
              : "Ask before running approval-tier actions")
    }
}
